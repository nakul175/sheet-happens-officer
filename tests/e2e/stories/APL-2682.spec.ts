// APL-2682. Refusal paths never open a connection. The Leader check runs on a disposable schema.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { verifyPassword } from "../../../src/lib/auth";
import { EDITOR_EMAIL, LEADER_EMAIL, QA_PROJECT_NAME, runStagingEditor, type DbConnect } from "../../../scripts/staging-editor";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for this test.");

const PASSWORD = "staging-editor-1";
const schema = `zzeditor_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
if (!/^zzeditor_[a-z0-9]+$/.test(schema)) throw new Error("Unsafe schema name.");
const schemaUrl = schemaDatabaseUrl(databaseUrl, schema);

let admin: PrismaClient;
let db: PrismaClient;
let publicUsers = 0;

function schemaDatabaseUrl(base: string, name: string) {
  const url = new URL(base);
  url.searchParams.set("schema", name);
  return url.toString();
}

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? databaseUrl,
    APP_URL: "http://localhost:3100",
    SHO_STAGING_CONFIRM: "1",
    STAGING_WORKSPACE_ID: "workspace",
    STAGING_EDITOR_PASSWORD: PASSWORD,
    PROD_DB_HOST: "",
    PROD_DB_NAME: "",
    ...over,
    NODE_ENV: "test",
  };
}

async function capture(run: () => Promise<number>) {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { code: await run(), text: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("APL-2682 staging editor", () => {
  it("refuses a non-local host, an uppercase name, a query-host bypass, and a DigitalOcean host", async () => {
    const cases: { name: string; url: string; message: string }[] = [
      {
        name: "wrong database name",
        url: "postgresql://example:example@db.example.com:5432/sho_prod",
        message: "non-local database host",
      },
      {
        name: "uppercase staging name",
        url: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/SHO_STAGING",
        message: "non-local database host",
      },
      {
        name: "mixed-case staging name",
        url: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/Sho_Staging",
        message: "non-local database host",
      },
      {
        name: "near-miss staging name",
        url: "postgresql://example:example@db.example.com:5432/sho-staging",
        message: "non-local database host",
      },
      {
        name: "host query bypass",
        url: "postgresql://example:example@localhost:5432/sho_staging?host=private-db-postgresql-nyc1-12345.db.ondigitalocean.com",
        message: "must not set host or dbname",
      },
      {
        name: "dbname query bypass",
        url: "postgresql://example:example@db.example.com:5432/sho_staging?dbname=defaultdb",
        message: "must not set host or dbname",
      },
      {
        name: "digitalocean host",
        url: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/defaultdb",
        message: "non-local database host",
      },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const over: Record<string, string> = { DATABASE_URL: item.url, DIRECT_DATABASE_URL: item.url };
      const { code, text } = await capture(() => runStagingEditor(env(over), ["--confirm-staging"], connect));
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain(item.message);
      expect(text, item.name).not.toContain("postgresql://");
      expect(text, item.name).not.toContain("ondigitalocean.com");
      expect(text, item.name).not.toContain(PASSWORD);
    }
  });

  it("does not treat a different case of the production database name as a match", async () => {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "").split("/")[0] ?? "");
    expect(name).not.toBe(name.toUpperCase());
    let connected = false;
    const connect: DbConnect = () => {
      connected = true;
      throw new Error("stop-before-query");
    };
    const { code, text } = await capture(() =>
      runStagingEditor(env({ PROD_DB_NAME: name.toUpperCase() }), ["--confirm-staging"], connect),
    );
    expect(connected).toBe(true);
    expect(code).toBe(1);
    expect(text).not.toContain("database name is production");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("postgresql://");
  });

  describe("disposable schema", () => {
    beforeAll(async () => {
      admin = new PrismaClient({ datasourceUrl: databaseUrl });
      publicUsers = await admin.user.count();
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      execFileSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: { ...process.env, DATABASE_URL: schemaUrl, DIRECT_DATABASE_URL: schemaUrl },
        stdio: "pipe",
      });
      db = new PrismaClient({ datasourceUrl: schemaUrl });
    }, 120000);

    afterAll(async () => {
      await db?.$disconnect().catch(() => undefined);
      if (admin) {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        expect(await admin.user.count()).toBe(publicUsers);
        await admin.$disconnect();
      }
    });

    it("makes a ZZ-TEST user the Leader and leaves an existing password in place", async () => {
      const workspace = await db.workspace.create({ data: { name: "ZZ-TEST disposable editor" } });
      const project = await db.project.create({ data: { workspaceId: workspace.id, name: QA_PROJECT_NAME, typeId: "wst_project" } });
      const outsider = await db.user.create({
        data: {
          workspaceId: workspace.id,
          email: "person-already-leader@example.invalid",
          name: "Already",
          passwordHash: "not-used",
          orgRole: "MEMBER",
          emailVerifiedAt: new Date(),
        },
      });
      await db.projectMember.create({ data: { projectId: project.id, userId: outsider.id, role: "LEADER" } });

      const first = await capture(() =>
        runStagingEditor(
          env({ DATABASE_URL: schemaUrl, DIRECT_DATABASE_URL: schemaUrl, STAGING_WORKSPACE_ID: workspace.id }),
          ["--confirm-staging"],
        ),
      );
      expect(first.code, first.text).toBe(0);
      expect(first.text).toContain("leaderRole: LEADER");
      expect(first.text).not.toContain(PASSWORD);
      expect(first.text).not.toContain("postgresql://");

      const editor = await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } });
      const leader = await db.user.findUniqueOrThrow({ where: { email: LEADER_EMAIL } });
      expect(leader.id).not.toBe(editor.id);
      expect(editor.orgRole).toBe("MEMBER");
      expect(leader.orgRole).toBe("MEMBER");
      expect(editor.deactivatedAt).toBeNull();
      expect(leader.deactivatedAt).toBeNull();
      expect(editor.emailVerifiedAt).not.toBeNull();
      expect(leader.emailVerifiedAt).not.toBeNull();
      expect(await verifyPassword(PASSWORD, editor.passwordHash)).toBe(true);
      expect(await verifyPassword(PASSWORD, leader.passwordHash)).toBe(true);
      const members = await db.projectMember.findMany({ where: { projectId: project.id } });
      expect(members.find((member) => member.userId === editor.id)?.role).toBe("EDITOR");
      expect(members.find((member) => member.userId === leader.id)?.role).toBe("LEADER");
      expect(members.find((member) => member.userId === outsider.id)?.role).toBe("EDITOR");
      expect(members.filter((member) => member.role === "LEADER")).toHaveLength(1);

      const second = await capture(() =>
        runStagingEditor(
          env({
            DATABASE_URL: schemaUrl,
            DIRECT_DATABASE_URL: schemaUrl,
            STAGING_WORKSPACE_ID: workspace.id,
            STAGING_EDITOR_PASSWORD: "staging-editor-2",
          }),
          ["--confirm-staging"],
        ),
      );
      expect(second.code, second.text).toBe(0);
      expect(second.text).toContain("editorPassword: unchanged");
      expect(second.text).toContain("leaderPassword: unchanged");
      expect((await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } })).passwordHash).toBe(editor.passwordHash);
      expect((await db.user.findUniqueOrThrow({ where: { email: LEADER_EMAIL } })).passwordHash).toBe(leader.passwordHash);
    });
  });
});
