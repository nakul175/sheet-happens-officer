// APL-2682. CI checks for scripts/staging-editor.ts against the test database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { verifyPassword } from "../src/lib/auth";
import { EDITOR_EMAIL, LEADER_EMAIL, QA_PROJECT_NAME, runStagingEditor, type DbConnect } from "../scripts/staging-editor";
import { Client } from "./helpers";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for this test.");

const db = new PrismaClient();
const PASSWORD = "staging-editor-1";
const OTHER_PASSWORD = "staging-editor-2";
const PROD_APP = "app.sheethappensofficer.com";

let workspaceId = "";

const target = new URL(databaseUrl);
const dbHost = target.hostname;
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const hasNodeEnv = Object.prototype.hasOwnProperty.call(over, "NODE_ENV");
  const { NODE_ENV: nodeEnv, ...rest } = over;
  const result: Record<string, string | undefined> = {
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? databaseUrl,
    APP_URL: "http://localhost:3100",
    SHO_STAGING_CONFIRM: "1",
    STAGING_WORKSPACE_ID: workspaceId,
    STAGING_EDITOR_PASSWORD: PASSWORD,
    PROD_DB_HOST: "",
    PROD_DB_NAME: "",
    ...rest,
  };
  if (!(hasNodeEnv && nodeEnv === undefined)) result.NODE_ENV = hasNodeEnv ? nodeEnv : "test";
  return result as NodeJS.ProcessEnv;
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
    const code = await run();
    return { code, text: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// qa:TC-APL2682-97ed5b9f@v1
function expectNoSecrets(text: string, secrets: string[]) {
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("postgres://");
  expect(text).not.toContain("scrypt$");
  expect(text).not.toContain(PROD_APP);
  for (const secret of secrets) if (secret.length >= 8) expect(text).not.toContain(secret);
}

async function wipe() {
  const users = await db.user.findMany({
    where: workspaceId
      ? { OR: [{ workspaceId }, { email: { in: [EDITOR_EMAIL, LEADER_EMAIL] } }] }
      : { email: { in: [EDITOR_EMAIL, LEADER_EMAIL] } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  if (ids.length) {
    await db.task.deleteMany({ where: { OR: [{ assigneeId: { in: ids } }, { createdById: { in: ids } }] } });
    await db.actionLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { undoneById: { in: ids } }] } });
    await db.modelUsage.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (workspaceId) {
    await db.task.deleteMany({ where: { workspaceId } });
    await db.project.deleteMany({ where: { workspaceId } });
  }
}

describe("staging editor (APL-2682)", () => {
  beforeAll(async () => {
    const workspace = await db.workspace.create({ data: { name: "ZZ-TEST staging editor" } });
    workspaceId = workspace.id;
  });

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.$disconnect();
  });

  it("refuses production and a missing confirmation flag before connecting, and leaves the test database unchanged", async () => {
    const canary = await db.user.create({
      data: { workspaceId, email: `canary-${workspaceId}@example.invalid`, name: "Canary", passwordHash: "not-used" },
    });
    const usersBefore = await db.user.count();
    const fakeUrl = `postgresql://example:example@${PROD_APP}:5432/prod`;
    const cases: { name: string; env: NodeJS.ProcessEnv; argv: string[]; message: string }[] = [
      // qa:TC-APL2682-64592871@v1
      { name: "production app host", env: env({ DATABASE_URL: fakeUrl, DIRECT_DATABASE_URL: fakeUrl }), argv: ["--confirm-staging"], message: "database host is production" },
      { name: "production app url", env: env({ APP_URL: `https://${PROD_APP}` }), argv: ["--confirm-staging"], message: "app host is production" },
      { name: "PROD_DB_HOST", env: env({ PROD_DB_HOST: dbHost }), argv: ["--confirm-staging"], message: "database host is production" },
      { name: "PROD_DB_NAME", env: env({ PROD_DB_NAME: dbName }), argv: ["--confirm-staging"], message: "database name is production" },
      {
        name: "production direct url",
        env: env({ DIRECT_DATABASE_URL: fakeUrl }),
        argv: ["--confirm-staging"],
        message: "database host is production",
      },
      // qa:TC-APL2682-2f7dcac3@v1
      { name: "missing confirmation", env: env({ SHO_STAGING_CONFIRM: undefined }), argv: [], message: "without staging confirmation" },
      { name: "missing workspace", env: env({ STAGING_WORKSPACE_ID: undefined }), argv: ["--confirm-staging"], message: "STAGING_WORKSPACE_ID is not set" },
      { name: "blank workspace", env: env({ STAGING_WORKSPACE_ID: "  " }), argv: ["--confirm-staging"], message: "STAGING_WORKSPACE_ID is not set" },
      {
        name: "localhost other database name",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "loopback other database name",
        env: env({
          DATABASE_URL: "postgresql://example:example@127.0.0.1:5432/sho",
          DIRECT_DATABASE_URL: "postgresql://example:example@127.0.0.1:5432/sho",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "localhost sho_test without NODE_ENV",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          NODE_ENV: undefined,
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "localhost sho_test in production",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          NODE_ENV: "production",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "remote sho_test in test",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho_test",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho_test",
          NODE_ENV: "test",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "digitalocean sho_test in test",
        env: env({
          DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/sho_test",
          DIRECT_DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/sho_test",
          NODE_ENV: "test",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "PROD_DB_NAME sho_test",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test",
          NODE_ENV: "test",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "sho_test",
        }),
        argv: ["--confirm-staging"],
        message: "database name is production",
      },
      {
        name: "digitalocean host",
        env: env({
          DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/defaultdb",
          DIRECT_DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/defaultdb",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      // qa:TC-APL2682-3ff6e3e4@v1
      {
        name: "uppercase prod name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/SHO_PROD",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/SHO_PROD",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "sho_prod",
        }),
        argv: ["--confirm-staging"],
        message: "database name is production",
      },
      {
        name: "mixed-case prod name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/Sho_Prod",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/Sho_Prod",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "sho_prod",
        }),
        argv: ["--confirm-staging"],
        message: "database name is production",
      },
      // qa:TC-APL2682-c0ead628@v1
      {
        name: "wrong database name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho_prod",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho_prod",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      // qa:TC-APL2682-b8d734f4@v1
      {
        name: "uppercase staging name",
        env: env({
          DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/SHO_STAGING",
          DIRECT_DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/SHO_STAGING",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      {
        name: "mixed-case staging name",
        env: env({
          DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/Sho_Staging",
          DIRECT_DATABASE_URL: "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/Sho_Staging",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      // qa:TC-APL2682-c0ead628@v1
      {
        name: "near-miss staging name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho-staging",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/sho-staging",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "exactly sho_staging",
      },
      // qa:TC-APL2682-44aceb49@v1
      {
        name: "host query bypass",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test?host=private-db-postgresql-nyc1-12345.db.ondigitalocean.com",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test?host=private-db-postgresql-nyc1-12345.db.ondigitalocean.com",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "must not set host or dbname",
      },
      {
        name: "dbname query bypass",
        env: env({
          DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test?dbname=defaultdb",
          DIRECT_DATABASE_URL: "postgresql://example:example@localhost:5432/sho_test?dbname=defaultdb",
          PROD_DB_HOST: "",
          PROD_DB_NAME: "",
        }),
        argv: ["--confirm-staging"],
        message: "must not set host or dbname",
      },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const { code, text } = await capture(() => runStagingEditor(item.env, item.argv, connect));
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain(item.message);
      expectNoSecrets(text, [PASSWORD, OTHER_PASSWORD, "example:example", "ondigitalocean.com", "db.example.com"]);
    }
    expect(await db.user.count()).toBe(usersBefore);
    expect(await db.user.findUnique({ where: { id: canary.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { email: EDITOR_EMAIL } })).toBeNull();
    expect(await db.user.findUnique({ where: { email: LEADER_EMAIL } })).toBeNull();
  });

  // qa:TC-APL2682-da0df1dc@v1
  it("allows a DigitalOcean host only when the database name is sho_staging", async () => {
    let connected = false;
    const connect: DbConnect = () => {
      connected = true;
      throw new Error("stop-before-query");
    };
    const url = "postgresql://example:example@private-db-postgresql-nyc1-12345.db.ondigitalocean.com:25060/sho_staging";
    const { code, text } = await capture(() =>
      runStagingEditor(env({ DATABASE_URL: url, DIRECT_DATABASE_URL: url, PROD_DB_HOST: "", PROD_DB_NAME: "" }), ["--confirm-staging"], connect),
    );
    expect(connected).toBe(true);
    expect(code).toBe(1);
    expect(text).not.toContain("exactly sho_staging");
    expectNoSecrets(text, [PASSWORD, "example:example", "ondigitalocean.com"]);
  });

  // qa:TC-APL2682-3ff6e3e4@v1
  it("refuses a different case of PROD_DB_NAME before connecting", async () => {
    expect(dbName).not.toBe(dbName.toUpperCase());
    let connected = false;
    const connect: DbConnect = () => {
      connected = true;
      throw new Error("connected");
    };
    const { code, text } = await capture(() => runStagingEditor(env({ PROD_DB_NAME: dbName.toUpperCase() }), ["--confirm-staging"], connect));
    expect(connected).toBe(false);
    expect(code).toBe(1);
    expect(text).toContain("database name is production");
    expectNoSecrets(text, [PASSWORD, OTHER_PASSWORD]);
  });

  // qa:TC-APL2682-0843a4a6@v1
  it("is idempotent and does not reset an existing password", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sho-staging-editor-"));
    const file = path.join(dir, "password");
    writeFileSync(file, `${PASSWORD}\n`, { mode: 0o600 });
    try {
      const first = await capture(() =>
        runStagingEditor(env({ STAGING_EDITOR_PASSWORD: undefined, STAGING_EDITOR_PASSWORD_FILE: file }), ["--confirm-staging"]),
      );
      expect(first.code, first.text).toBe(0);
      expect(first.text).toContain("editorPassword: set");
      expect(first.text).toContain("leaderPassword: set");
      expect(first.text).toContain("leaderRole: LEADER");
      expectNoSecrets(first.text, [PASSWORD, OTHER_PASSWORD]);

      const created = await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } });
      const project = await db.project.findFirstOrThrow({ where: { workspaceId, name: QA_PROJECT_NAME } });
      const before = {
        hash: created.passwordHash,
        verified: created.emailVerifiedAt?.toISOString(),
        members: await db.projectMember.count({ where: { userId: created.id } }),
        sections: await db.section.count({ where: { projectId: project.id } }),
        projects: await db.project.count({ where: { workspaceId, name: QA_PROJECT_NAME } }),
        updatedAt: project.updatedAt.toISOString(),
      };

      const leaderBefore = await db.user.findUniqueOrThrow({ where: { email: LEADER_EMAIL } });
      const second = await capture(() => runStagingEditor(env({ STAGING_EDITOR_PASSWORD: OTHER_PASSWORD }), ["--confirm-staging"]));
      expect(second.code, second.text).toBe(0);
      expect(second.text).toContain("editorPassword: unchanged");
      expect(second.text).toContain("leaderPassword: unchanged");
      expectNoSecrets(second.text, [PASSWORD, OTHER_PASSWORD]);

      const again = await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } });
      const leaderAgain = await db.user.findUniqueOrThrow({ where: { email: LEADER_EMAIL } });
      const projectAgain = await db.project.findFirstOrThrow({ where: { workspaceId, name: QA_PROJECT_NAME } });
      expect(leaderAgain.id).not.toBe(again.id);
      expect(again.deactivatedAt).toBeNull();
      expect(leaderAgain.deactivatedAt).toBeNull();
      expect(again.emailVerifiedAt).not.toBeNull();
      expect(leaderAgain.emailVerifiedAt).not.toBeNull();
      expect(again.passwordHash).toBe(before.hash);
      expect(leaderAgain.passwordHash).toBe(leaderBefore.passwordHash);
      expect(await verifyPassword(PASSWORD, leaderAgain.passwordHash)).toBe(true);
      expect(again.passwordHash.startsWith("scrypt$")).toBe(true);
      expect(await verifyPassword(PASSWORD, again.passwordHash)).toBe(true);
      expect(await verifyPassword(OTHER_PASSWORD, again.passwordHash)).toBe(false);
      expect(again.emailVerifiedAt?.toISOString()).toBe(before.verified);
      expect(await db.projectMember.count({ where: { userId: again.id } })).toBe(before.members);
      expect(await db.section.count({ where: { projectId: projectAgain.id } })).toBe(before.sections);
      expect(await db.project.count({ where: { workspaceId, name: QA_PROJECT_NAME } })).toBe(before.projects);
      expect(projectAgain.updatedAt.toISOString()).toBe(before.updatedAt);
      expect(again.id).toBe(created.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // qa:TC-APL2682-0843a4a6@v1
  // qa:TC-APL2682-8bc1699b@v1
  it("keeps Editor rights on ZZ-TEST QA only and no admin role", async () => {
    const hash = "already-set-hash";
    const leaderHash = "leader-already-set";
    const user = await db.user.create({
      data: {
        workspaceId,
        email: EDITOR_EMAIL,
        name: "ZZ Test Editor",
        passwordHash: hash,
        orgRole: "ADMIN",
        emailVerifiedAt: null,
        deactivatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    const dormant = await db.user.create({
      data: {
        workspaceId,
        email: LEADER_EMAIL,
        name: "Dormant Leader",
        passwordHash: leaderHash,
        orgRole: "ADMIN",
        emailVerifiedAt: null,
        deactivatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    const qa = await db.project.create({ data: { workspaceId, name: QA_PROJECT_NAME, typeId: "wst_project" } });
    const other = await db.project.create({ data: { workspaceId, name: "Other project", typeId: "wst_project" } });
    await db.projectMember.create({ data: { projectId: qa.id, userId: user.id, role: "LEADER" } });
    await db.projectMember.create({ data: { projectId: other.id, userId: user.id, role: "EDITOR" } });

    const { code, text } = await capture(() => runStagingEditor(env({ STAGING_EDITOR_PASSWORD: OTHER_PASSWORD }), ["--confirm-staging"]));
    expect(code, text).toBe(0);
    expect(text).toContain("editorPassword: unchanged");
    expect(text).toContain("leaderPassword: unchanged");
    expect(text).toContain("leaderRole: LEADER");
    expectNoSecrets(text, [PASSWORD, OTHER_PASSWORD, hash, leaderHash]);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.orgRole).toBe("MEMBER");
    expect(after.orgRole).not.toBe("ADMIN");
    expect(after.orgRole).not.toBe("SUPER_ADMIN");
    expect(after.deactivatedAt).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.passwordHash).toBe(hash);

    const memberships = await db.projectMember.findMany({ where: { userId: user.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].projectId).toBe(qa.id);
    expect(memberships[0]?.role).toBe("EDITOR");
    expect(await db.projectMember.count({ where: { userId: user.id, role: "LEADER" } })).toBe(0);
    const leader = await db.user.findUniqueOrThrow({ where: { id: dormant.id } });
    expect(leader.id).not.toBe(after.id);
    expect(leader.orgRole).toBe("MEMBER");
    expect(leader.deactivatedAt).toBeNull();
    expect(leader.emailVerifiedAt).not.toBeNull();
    expect(leader.passwordHash).toBe(leaderHash);
    const leaders = await db.projectMember.findMany({ where: { projectId: qa.id, role: "LEADER" }, include: { user: true } });
    expect(leaders).toHaveLength(1);
    expect(leaders[0]?.user.id).toBe(dormant.id);
    expect(leaders[0]?.user.id).not.toBe(user.id);
    expect(leaders[0]?.user.email).toBe(LEADER_EMAIL);
    expect(leaders[0]?.user.orgRole).toBe("MEMBER");

    const sections = await db.section.findMany({ where: { projectId: qa.id }, orderBy: { position: "asc" } });
    expect(sections.map((section) => ({ name: section.name, isDone: section.isDone }))).toEqual([
      { name: "To do", isDone: false },
      { name: "In progress", isDone: false },
      { name: "Done", isDone: true },
    ]);
  });

  // qa:TC-APL2682-8bc1699b@v1
  // qa:TC-APL2682-b2c724e4@v1
  // qa:TC-APL2682-39098679@v1
  it("lets the Editor edit a task and returns 403 for Trash restore", async () => {
    const ready = await capture(() => runStagingEditor(env(), ["--confirm-staging"]));
    expect(ready.code, ready.text).toBe(0);
    const project = await db.project.findFirstOrThrow({ where: { workspaceId, name: QA_PROJECT_NAME } });
    const leaders = await db.projectMember.findMany({ where: { projectId: project.id, role: "LEADER" }, include: { user: true } });
    const editorUser = await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } });
    expect(leaders).toHaveLength(1);
    expect(leaders[0]?.user.email).toBe(LEADER_EMAIL);
    expect(leaders[0]?.user.id).not.toBe(editorUser.id);
    expect(leaders[0]?.user.deactivatedAt).toBeNull();
    expect(leaders[0]?.user.emailVerifiedAt).not.toBeNull();
    expect(editorUser.deactivatedAt).toBeNull();

    const editor = new Client();
    const signin = await editor.post("/api/auth/signin", { email: EDITOR_EMAIL, password: PASSWORD });
    expect(signin.status, JSON.stringify(signin.json)).toBe(200);
    const created = await editor.post(`/api/projects/${project.id}/tasks`, { title: "QA edit" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const taskId = created.json.task.id as string;
    const seen = (await editor.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
    const edited = await editor.patch(`/api/tasks/${taskId}`, { title: "QA edited", expectedUpdatedAt: seen });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json.task.title).toBe("QA edited");
    expect((await editor.del(`/api/tasks/${taskId}`)).status).toBe(204);
    const restore = await editor.post(`/api/tasks/${taskId}/restore`);
    expect(restore.status).toBe(403);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.title).toBe("QA edited");
  });
});
