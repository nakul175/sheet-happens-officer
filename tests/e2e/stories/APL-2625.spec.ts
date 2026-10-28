// APL-2625. Integration coverage on a disposable Postgres schema.
// D1–D4 and a ZZ-only purge. This file does not point the script at any other database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { runPurge, type DbConnect } from "../../../scripts/purge-zz-test";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for this test.");

const dbName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "").split("/")[0] ?? "");
const schema = `zzpurge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
if (!/^zzpurge_[a-z0-9]+$/.test(schema)) throw new Error("Unsafe schema name.");

const schemaUrl = schemaDatabaseUrl(databaseUrl, schema);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

let admin: PrismaClient;
let db: PrismaClient;
let publicUsers = 0;
let workspaceId = "";
let tag = "";

function schemaDatabaseUrl(base: string, name: string) {
  const url = new URL(base);
  url.searchParams.set("schema", name);
  return url.toString();
}

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: schemaUrl,
    DIRECT_DATABASE_URL: schemaUrl,
    APP_URL: "http://localhost:3100",
    SHO_ALLOW_TEST_PURGE: "1",
    STAGING_WORKSPACE_ID: workspaceId,
    PROD_DB_HOST: "prod.example.invalid",
    PROD_DB_NAME: "sho_prod",
    ...over,
    NODE_ENV: "test",
  };
}

function applyArgv(confirm = dbName) {
  return ["--workspace", workspaceId, "--apply", `--confirm=${confirm}`];
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

async function person(local: string, opts: { deactivated: boolean; ageHours: number; email?: string }) {
  const email = opts.email ?? `zz-test-${local}-${tag}@example.invalid`;
  return db.user.create({
    data: {
      workspaceId,
      email,
      name: local,
      passwordHash: "not-used",
      orgRole: "MEMBER",
      emailVerifiedAt: hoursAgo(opts.ageHours),
      deactivatedAt: opts.deactivated ? hoursAgo(Math.min(opts.ageHours, 48)) : null,
      createdAt: hoursAgo(opts.ageHours),
    },
  });
}

async function board() {
  const project = await db.project.create({ data: { workspaceId, name: "ZZ purge", typeId: "wst_project" } });
  const section = await db.section.create({ data: { projectId: project.id, name: "To do", position: 0 } });
  return { project, section };
}

describe("APL-2625 purge on a disposable schema", () => {
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

  beforeEach(async () => {
    const workspace = await db.workspace.create({ data: { name: "ZZ-TEST disposable" } });
    workspaceId = workspace.id;
    tag = workspaceId.slice(-8).toLowerCase();
  });

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      expect(await admin.user.count()).toBe(publicUsers);
      await admin.$disconnect();
    }
  });

  it("refuses --apply when a non-ZZ row would be set null (D1)", async () => {
    const zz = await person("approver", { deactivated: true, ageHours: 48 });
    const keeper = await person("keeper", { deactivated: false, ageHours: 48, email: `keeper-${tag}@example.invalid` });
    const { section, project } = await board();
    const task = await db.task.create({
      data: {
        workspaceId,
        projectId: project.id,
        sectionId: section.id,
        title: "kept",
        assigneeId: keeper.id,
        createdById: keeper.id,
        approverId: zz.id,
        previousAssigneeId: zz.id,
        deletedById: zz.id,
      },
    });
    await db.notification.create({ data: { recipientId: keeper.id, actorId: zz.id, type: "test" } });
    await db.actionLog.create({
      data: {
        actorId: keeper.id,
        undoneById: zz.id,
        channel: "SCREEN",
        targetType: "task",
        targetId: task.id,
        action: "task.updated",
      },
    });

    const dry = await capture(() => runPurge(env(), ["--workspace", workspaceId]));
    expect(dry.code, dry.text).toBe(1);
    expect(dry.text).toContain("purge would change rows that are not ZZ-TEST");
    expect(dry.text).toContain("Task.approverId: 1");
    expect(dry.text).toContain("Task.previousAssigneeId: 1");
    expect(dry.text).toContain("Task.deletedById: 1");
    expect(dry.text).toContain("Notification.actorId: 1");
    expect(dry.text).toContain("ActionLog.undoneById: 1");
    expect(dry.text).not.toContain("postgresql://");

    const applied = await capture(() => runPurge(env(), applyArgv()));
    expect(applied.code, applied.text).toBe(1);
    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.approverId).toBe(zz.id);
    expect(row.previousAssigneeId).toBe(zz.id);
    expect(row.deletedById).toBe(zz.id);
    expect(await db.notification.findFirstOrThrow({ where: { recipientId: keeper.id } })).toMatchObject({ actorId: zz.id });
    expect(await db.actionLog.findFirstOrThrow({ where: { actorId: keeper.id } })).toMatchObject({ undoneById: zz.id });
    expect(await db.user.findUnique({ where: { id: zz.id } })).not.toBeNull();
  });

  it("refuses --apply when deleting a ZZ task would cascade a non-ZZ collaborator (D2)", async () => {
    const zz = await person("owner", { deactivated: true, ageHours: 48 });
    const keeper = await person("collab", { deactivated: false, ageHours: 48, email: `collab-${tag}@example.invalid` });
    const { section, project } = await board();
    const task = await db.task.create({
      data: {
        workspaceId,
        projectId: project.id,
        sectionId: section.id,
        title: "zz only",
        assigneeId: zz.id,
        createdById: zz.id,
      },
    });
    await db.taskCollaborator.create({ data: { taskId: task.id, userId: keeper.id } });

    const dry = await capture(() => runPurge(env(), ["--workspace", workspaceId]));
    expect(dry.code, dry.text).toBe(1);
    expect(dry.text).toContain("cascade Task: 1");
    expect(dry.text).toContain("cascade TaskCollaborator: 1");
    expect(dry.text).toContain("cascade TaskCollaborator.outside: 1");
    expect(dry.text).not.toContain("postgresql://");

    const applied = await capture(() => runPurge(env(), applyArgv()));
    expect(applied.code, applied.text).toBe(1);
    expect(await db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
    expect(await db.taskCollaborator.findUnique({ where: { taskId_userId: { taskId: task.id, userId: keeper.id } } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: zz.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: keeper.id } })).not.toBeNull();
  });

  it("refuses --apply when --confirm is missing or empty, before connecting", async () => {
    const zz = await person("confirm", { deactivated: true, ageHours: 48 });
    const cases = [
      { name: "missing confirm", argv: ["--workspace", workspaceId, "--apply"] },
      { name: "empty confirm", argv: ["--workspace", workspaceId, "--apply", "--confirm="] },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const { code, text } = await capture(() => runPurge(env(), item.argv, connect));
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain("--confirm must match the current database");
      expect(text, item.name).not.toContain("postgresql://");
    }
    expect(await db.user.findUnique({ where: { id: zz.id } })).not.toBeNull();
  });

  it("refuses a different case of PROD_DB_NAME before connecting", async () => {
    const cases = [
      { name: "uppercase prod name", database: "SHO_PROD" },
      { name: "mixed-case prod name", database: "Sho_Prod" },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const url = `postgresql://example:example@db.example.com:5432/${item.database}`;
      const { code, text } = await capture(() =>
        runPurge(env({ DATABASE_URL: url, DIRECT_DATABASE_URL: url, PROD_DB_NAME: "sho_prod" }), applyArgv(item.database), connect),
      );
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain("database name is production");
      expect(text, item.name).not.toContain("postgresql://");
    }
  });

  it("fails closed when PROD_DB_HOST or PROD_DB_NAME is blank (D3)", async () => {
    const cases = [
      { name: "empty host", env: env({ PROD_DB_HOST: "" }) },
      { name: "whitespace host", env: env({ PROD_DB_HOST: " \t" }) },
      { name: "empty name", env: env({ PROD_DB_NAME: "" }) },
      { name: "whitespace name", env: env({ PROD_DB_NAME: "  " }) },
      { name: "missing host", env: env({ PROD_DB_HOST: undefined }) },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const { code, text } = await capture(() => runPurge(item.env, applyArgv(), connect));
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain("PROD_DB_HOST and PROD_DB_NAME must be set");
      expect(text, item.name).not.toContain("postgresql://");
    }
  });

  it("refuses /opt/sho, anything under it, and a symlink to it (D4)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sho-deploy-"));
    const exact = path.join(dir, "exact");
    const nested = path.join(dir, "nested");
    symlinkSync("/opt/sho", exact);
    symlinkSync("/opt/sho/releases/abc", nested);
    const script = fileURLToPath(new URL("../../../scripts/purge-zz-test.ts", import.meta.url));
    const cases = [
      { name: "cwd exact", locations: { cwd: "/opt/sho", scriptPath: script } },
      { name: "cwd child", locations: { cwd: "/opt/sho/releases/abc", scriptPath: script } },
      { name: "cwd symlink", locations: { cwd: exact, scriptPath: script } },
      { name: "cwd nested symlink", locations: { cwd: nested, scriptPath: script } },
      { name: "script path", locations: { cwd: dir, scriptPath: "/opt/sho/scripts/purge-zz-test.ts" } },
      { name: "script exact", locations: { cwd: dir, scriptPath: "/opt/sho" } },
    ];
    try {
      for (const item of cases) {
        let connected = false;
        const connect: DbConnect = () => {
          connected = true;
          throw new Error("connected");
        };
        const { code, text } = await capture(() => runPurge(env(), applyArgv(), connect, item.locations));
        expect(code, item.name).toBe(1);
        expect(connected, item.name).toBe(false);
        expect(text, item.name).toContain("this script is not deployed");
      }
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const allowed = await capture(() =>
        runPurge(env({ SHO_ALLOW_TEST_PURGE: undefined }), ["--workspace", workspaceId], connect, {
          cwd: "/opt/shock",
          scriptPath: script,
        }),
      );
      expect(allowed.code).toBe(1);
      expect(connected).toBe(false);
      expect(allowed.text).toContain("without SHO_ALLOW_TEST_PURGE=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges ZZ-only rows after --confirm matches the database, and refuses a wrong confirm", async () => {
    const zz = await person("gone", { deactivated: true, ageHours: 48 });
    const keeper = await person("stays", { deactivated: false, ageHours: 48, email: `stays-${tag}@example.invalid` });
    const { section, project } = await board();
    await db.session.create({ data: { userId: zz.id, tokenHash: `zz-${zz.id}`, expiresAt: hoursAgo(-24) } });
    await db.projectMember.create({ data: { projectId: project.id, userId: zz.id, role: "EDITOR" } });
    const owned = await db.task.create({
      data: {
        workspaceId,
        projectId: project.id,
        sectionId: section.id,
        title: "owned",
        assigneeId: zz.id,
        createdById: zz.id,
      },
    });
    const kept = await db.task.create({
      data: {
        workspaceId,
        projectId: project.id,
        sectionId: section.id,
        title: "kept",
        assigneeId: keeper.id,
        createdById: keeper.id,
      },
    });

    const dry = await capture(() => runPurge(env(), ["--workspace", workspaceId]));
    expect(dry.code, dry.text).toBe(0);
    expect(dry.text).toContain("mode: dry-run");
    expect(dry.text).toContain(`email: ${zz.email}`);
    expect(dry.text).toContain("cascade TaskCollaborator.outside: 0");
    expect(dry.text).toContain("cascade Task.descendantOutside: 0");
    expect(dry.text).not.toContain(keeper.id);
    expect(await db.user.findUnique({ where: { id: zz.id } })).not.toBeNull();

    const wrong = await capture(() => runPurge(env(), applyArgv("other-database")));
    expect(wrong.code, wrong.text).toBe(1);
    expect(wrong.text).toContain("--confirm must match the current database");
    expect(wrong.text).not.toContain(dbName);
    expect(await db.user.findUnique({ where: { id: zz.id } })).not.toBeNull();
    expect(await db.task.findUnique({ where: { id: owned.id } })).not.toBeNull();

    const applied = await capture(() => runPurge(env(), applyArgv()));
    expect(applied.code, applied.text).toBe(0);
    expect(applied.text).toContain("mode: apply");
    expect(applied.text).toContain("cascade TaskCollaborator.outside: 0");
    expect(await db.user.findUnique({ where: { id: zz.id } })).toBeNull();
    expect(await db.session.count({ where: { userId: zz.id } })).toBe(0);
    expect(await db.projectMember.count({ where: { userId: zz.id } })).toBe(0);
    expect(await db.task.findUnique({ where: { id: owned.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: keeper.id } })).not.toBeNull();
    expect(await db.task.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });
});
