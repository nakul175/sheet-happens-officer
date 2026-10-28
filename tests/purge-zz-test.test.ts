// APL-2625. CI checks for scripts/purge-zz-test.ts against the test database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { runPurge, type DbConnect } from "../scripts/purge-zz-test";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for this test.");

const db = new PrismaClient();
const PROD_APP = "app.sheethappensofficer.com";
const target = new URL(databaseUrl);
const dbHost = target.hostname;
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));

let workspaceId = "";
let otherWorkspaceId = "";
let tag = "";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? databaseUrl,
    APP_URL: "http://localhost:3100",
    SHO_ALLOW_TEST_PURGE: "1",
    STAGING_WORKSPACE_ID: workspaceId,
    PROD_DB_HOST: "prod.example.invalid",
    PROD_DB_NAME: "sho_prod",
    ...over,
    NODE_ENV: "test",
  };
}

const argv = (apply = false) =>
  apply ? ["--workspace", workspaceId, "--apply", `--confirm=${dbName}`] : ["--workspace", workspaceId];

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

function expectNoSecrets(text: string) {
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("postgres://");
  expect(text).not.toContain("not-used");
  expect(text).not.toContain(PROD_APP);
}

function listedIds(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice(4));
}

async function person(local: string, opts: { workspaceId?: string; deactivated: boolean; ageHours: number; email?: string }) {
  const email = opts.email ?? `zz-test-${local}-${tag}@example.invalid`;
  return db.user.create({
    data: {
      workspaceId: opts.workspaceId ?? workspaceId,
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

async function wipe() {
  const ids = [workspaceId, otherWorkspaceId].filter(Boolean);
  if (!ids.length) return;
  const users = await db.user.findMany({ where: { workspaceId: { in: ids } }, select: { id: true, email: true } });
  const userIds = users.map((user) => user.id);
  if (userIds.length) {
    await db.task.deleteMany({ where: { OR: [{ workspaceId: { in: ids } }, { assigneeId: { in: userIds } }, { createdById: { in: userIds } }] } });
    await db.actionLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { undoneById: { in: userIds } }] } });
    await db.modelUsage.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }] } });
    await db.loginAttempt.deleteMany({ where: { email: { in: users.map((user) => user.email) } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.task.deleteMany({ where: { workspaceId: { in: ids } } });
  await db.project.deleteMany({ where: { workspaceId: { in: ids } } });
}

describe("purge zz-test people (APL-2625)", () => {
  beforeAll(async () => {
    const staging = await db.workspace.create({ data: { name: "ZZ-TEST purge staging" } });
    const other = await db.workspace.create({ data: { name: "ZZ-TEST purge other" } });
    workspaceId = staging.id;
    otherWorkspaceId = other.id;
    tag = workspaceId.slice(-8).toLowerCase();
  });

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    if (otherWorkspaceId) await db.workspace.delete({ where: { id: otherWorkspaceId } }).catch(() => undefined);
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.$disconnect();
  });

  it("refuses without the flag or on production before connecting, and changes nothing", async () => {
    const canary = await person("canary", { deactivated: true, ageHours: 48 });
    const usersBefore = await db.user.count();
    const fakeUrl = `postgresql://example:example@${PROD_APP}:5432/prod`;
    const cases: { name: string; env: NodeJS.ProcessEnv; argv: string[]; message: string }[] = [
      { name: "missing flag", env: env({ SHO_ALLOW_TEST_PURGE: undefined }), argv: argv(true), message: "without SHO_ALLOW_TEST_PURGE=1" },
      { name: "production app host", env: env({ DATABASE_URL: fakeUrl, DIRECT_DATABASE_URL: fakeUrl }), argv: argv(true), message: "database host is production" },
      { name: "production app url", env: env({ APP_URL: `https://${PROD_APP}` }), argv: argv(true), message: "app host is production" },
      { name: "PROD_DB_HOST", env: env({ PROD_DB_HOST: dbHost }), argv: argv(true), message: "database host is production" },
      { name: "PROD_DB_NAME", env: env({ PROD_DB_NAME: dbName }), argv: argv(true), message: "database name is production" },
      { name: "production direct url", env: env({ DIRECT_DATABASE_URL: fakeUrl }), argv: argv(true), message: "database host is production" },
      { name: "workspace mismatch", env: env(), argv: ["--workspace", otherWorkspaceId, "--apply"], message: "does not match the configured staging workspace" },
      { name: "blank PROD_DB_HOST", env: env({ PROD_DB_HOST: "  " }), argv: argv(true), message: "PROD_DB_HOST and PROD_DB_NAME must be set" },
      { name: "empty PROD_DB_NAME", env: env({ PROD_DB_NAME: "" }), argv: argv(true), message: "PROD_DB_HOST and PROD_DB_NAME must be set" },
      { name: "missing PROD_DB_HOST", env: env({ PROD_DB_HOST: undefined }), argv: argv(false), message: "PROD_DB_HOST and PROD_DB_NAME must be set" },
      { name: "missing confirm", env: env(), argv: ["--workspace", workspaceId, "--apply"], message: "--confirm must match the current database" },
      { name: "empty confirm", env: env(), argv: ["--workspace", workspaceId, "--apply", "--confirm="], message: "--confirm must match the current database" },
      {
        name: "uppercase prod name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/SHO_PROD",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/SHO_PROD",
          PROD_DB_NAME: "sho_prod",
        }),
        argv: ["--workspace", workspaceId, "--apply", "--confirm=SHO_PROD"],
        message: "database name is production",
      },
      {
        name: "mixed-case prod name",
        env: env({
          DATABASE_URL: "postgresql://example:example@db.example.com:5432/Sho_Prod",
          DIRECT_DATABASE_URL: "postgresql://example:example@db.example.com:5432/Sho_Prod",
          PROD_DB_NAME: "sho_prod",
        }),
        argv: ["--workspace", workspaceId, "--apply", "--confirm=Sho_Prod"],
        message: "database name is production",
      },
    ];
    for (const item of cases) {
      let connected = false;
      const connect: DbConnect = () => {
        connected = true;
        throw new Error("connected");
      };
      const { code, text } = await capture(() => runPurge(item.env, item.argv, connect));
      expect(code, item.name).toBe(1);
      expect(connected, item.name).toBe(false);
      expect(text, item.name).toContain(item.message);
      expectNoSecrets(text);
    }
    expect(await db.user.count()).toBe(usersBefore);
    expect(await db.user.findUnique({ where: { id: canary.id } })).not.toBeNull();
  });

  it("dry-run prints counts and ids and changes nothing", async () => {
    const eligible = await person("dry", { deactivated: true, ageHours: 48 });
    await db.session.create({ data: { userId: eligible.id, tokenHash: `dry-${eligible.id}`, expiresAt: hoursAgo(-24) } });
    const active = await person("dry-active", { deactivated: false, ageHours: 48 });
    const before = await db.user.count();
    const sessionsBefore = await db.session.count({ where: { userId: eligible.id } });

    const { code, text } = await capture(() => runPurge(env(), argv(false)));
    expect(code, text).toBe(0);
    expect(text).toContain("mode: dry-run");
    expect(text).toContain("cascade TaskCollaborator.outside: 0");
    expect(text).toMatch(/^User: 1$/m);
    expect(text).toMatch(/^Session: 1$/m);
    expect(listedIds(text)).toEqual([eligible.id]);
    expect(text).toContain(`email: ${eligible.email}`);
    expect(text).not.toContain(active.id);
    expectNoSecrets(text);

    expect(await db.user.count()).toBe(before);
    expect(await db.user.findUnique({ where: { id: eligible.id } })).not.toBeNull();
    expect(await db.session.count({ where: { userId: eligible.id } })).toBe(sessionsBefore);
  });

  it("deletes only eligible rows under --apply", async () => {
    const eligible = await person("gone", { deactivated: true, ageHours: 48 });
    const partner = await person("partner", { deactivated: true, ageHours: 72 });
    const stranger = await person("stranger", { deactivated: true, ageHours: 48, email: `person-${tag}@example.invalid` });
    const elsewhere = await person("elsewhere", { deactivated: true, ageHours: 48, workspaceId: otherWorkspaceId });
    const keeper = await person("keeper", { deactivated: false, ageHours: 48, email: `keeper-${tag}@example.invalid` });
    const entangled = await person("entangled", { deactivated: true, ageHours: 48 });

    await db.session.create({ data: { userId: eligible.id, tokenHash: `apply-${eligible.id}`, expiresAt: hoursAgo(-24) } });
    await db.actionLog.create({
      data: { actorId: eligible.id, channel: "SCREEN", targetType: "task", targetId: "plain-id", action: "task.updated" },
    });
    await db.modelUsage.create({
      data: { userId: partner.id, model: "test", inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });

    const project = await db.project.create({ data: { workspaceId, name: "ZZ purge", typeId: "wst_project" } });
    const section = await db.section.create({ data: { projectId: project.id, name: "To do", position: 0 } });
    const owned = await db.task.create({
      data: { workspaceId, projectId: project.id, sectionId: section.id, title: "owned", assigneeId: eligible.id, createdById: partner.id },
    });
    const shared = await db.task.create({
      data: { workspaceId, projectId: project.id, sectionId: section.id, title: "shared", assigneeId: entangled.id, createdById: keeper.id },
    });

    const { code, text } = await capture(() => runPurge(env(), argv(true)));
    expect(code, text).toBe(0);
    expect(text).toContain("mode: apply");
    expect(listedIds(text).sort()).toEqual([eligible.id, partner.id].sort());
    expect(text).not.toContain(stranger.id);
    expect(text).not.toContain(elsewhere.id);
    expect(text).not.toContain(keeper.id);
    expect(text).not.toContain(entangled.id);
    expectNoSecrets(text);

    expect(await db.user.findUnique({ where: { id: eligible.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: partner.id } })).toBeNull();
    expect(await db.session.count({ where: { userId: eligible.id } })).toBe(0);
    expect(await db.actionLog.count({ where: { actorId: eligible.id } })).toBe(0);
    expect(await db.modelUsage.count({ where: { userId: partner.id } })).toBe(0);
    expect(await db.task.findUnique({ where: { id: owned.id } })).toBeNull();

    expect(await db.user.findUnique({ where: { id: stranger.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: elsewhere.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: keeper.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: entangled.id } })).not.toBeNull();
    expect(await db.task.findUnique({ where: { id: shared.id } })).not.toBeNull();
  });

  it("keeps audit-logged, recent, and active users", async () => {
    const eligible = await person("control", { deactivated: true, ageHours: 48 });
    const active = await person("active", { deactivated: false, ageHours: 96 });
    const recent = await person("recent", { deactivated: true, ageHours: 1 });
    const actor = await person("actor", { deactivated: true, ageHours: 48 });
    const target = await person("target", { deactivated: true, ageHours: 48 });
    await db.auditLog.create({ data: { event: "TEST_KEEP", actorId: actor.id } });
    await db.auditLog.create({ data: { event: "TEST_KEEP", targetType: "user", targetId: target.id } });

    const { code, text } = await capture(() => runPurge(env(), argv(true)));
    expect(code, text).toBe(0);
    expect(listedIds(text)).toEqual([eligible.id]);
    expect(text).not.toContain(active.id);
    expect(text).not.toContain(recent.id);
    expect(text).not.toContain(actor.id);
    expect(text).not.toContain(target.id);
    expectNoSecrets(text);

    expect(await db.user.findUnique({ where: { id: eligible.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: active.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: actor.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(await db.auditLog.count({ where: { OR: [{ actorId: actor.id }, { targetId: target.id }] } })).toBe(2);
  });
});
