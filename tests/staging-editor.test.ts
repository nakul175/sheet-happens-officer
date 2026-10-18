// APL-2682. CI checks for scripts/staging-editor.ts against the test database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { verifyPassword } from "../src/lib/auth";
import { EDITOR_EMAIL, QA_PROJECT_NAME, runStagingEditor, type DbConnect } from "../scripts/staging-editor";

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
  return {
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? databaseUrl,
    APP_URL: "http://localhost:3100",
    SHO_STAGING_CONFIRM: "1",
    STAGING_WORKSPACE_ID: workspaceId,
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
    const code = await run();
    return { code, text: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function expectNoSecrets(text: string, secrets: string[]) {
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("postgres://");
  expect(text).not.toContain("scrypt$");
  expect(text).not.toContain(PROD_APP);
  for (const secret of secrets) if (secret.length >= 8) expect(text).not.toContain(secret);
}

async function wipe() {
  const users = await db.user.findMany({
    where: workspaceId ? { OR: [{ workspaceId }, { email: EDITOR_EMAIL }] } : { email: EDITOR_EMAIL },
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
      { name: "missing confirmation", env: env({ SHO_STAGING_CONFIRM: undefined }), argv: [], message: "without staging confirmation" },
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
      expectNoSecrets(text, [PASSWORD, OTHER_PASSWORD, "example:example"]);
    }
    expect(await db.user.count()).toBe(usersBefore);
    expect(await db.user.findUnique({ where: { id: canary.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { email: EDITOR_EMAIL } })).toBeNull();
  });

  it("is idempotent and does not reset an existing password", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sho-staging-editor-"));
    const file = path.join(dir, "password");
    writeFileSync(file, `${PASSWORD}\n`, { mode: 0o600 });
    try {
      const first = await capture(() =>
        runStagingEditor(env({ STAGING_EDITOR_PASSWORD: undefined, STAGING_EDITOR_PASSWORD_FILE: file }), ["--confirm-staging"]),
      );
      expect(first.code, first.text).toBe(0);
      expect(first.text).toContain("password: set");
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

      const second = await capture(() => runStagingEditor(env({ STAGING_EDITOR_PASSWORD: OTHER_PASSWORD }), ["--confirm-staging"]));
      expect(second.code, second.text).toBe(0);
      expect(second.text).toContain("password: unchanged");
      expectNoSecrets(second.text, [PASSWORD, OTHER_PASSWORD]);

      const again = await db.user.findUniqueOrThrow({ where: { email: EDITOR_EMAIL } });
      const projectAgain = await db.project.findFirstOrThrow({ where: { workspaceId, name: QA_PROJECT_NAME } });
      expect(again.passwordHash).toBe(before.hash);
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

  it("keeps Editor rights on ZZ-TEST QA only and no admin role", async () => {
    const hash = "already-set-hash";
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
    const qa = await db.project.create({ data: { workspaceId, name: QA_PROJECT_NAME, typeId: "wst_project" } });
    const other = await db.project.create({ data: { workspaceId, name: "Other project", typeId: "wst_project" } });
    await db.projectMember.create({ data: { projectId: qa.id, userId: user.id, role: "LEADER" } });
    await db.projectMember.create({ data: { projectId: other.id, userId: user.id, role: "EDITOR" } });

    const { code, text } = await capture(() => runStagingEditor(env({ STAGING_EDITOR_PASSWORD: OTHER_PASSWORD }), ["--confirm-staging"]));
    expect(code, text).toBe(0);
    expect(text).toContain("password: unchanged");
    expectNoSecrets(text, [PASSWORD, OTHER_PASSWORD, hash]);

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

    const sections = await db.section.findMany({ where: { projectId: qa.id }, orderBy: { position: "asc" } });
    expect(sections.map((section) => ({ name: section.name, isDone: section.isDone }))).toEqual([
      { name: "To do", isDone: false },
      { name: "In progress", isDone: false },
      { name: "Done", isDone: true },
    ]);
  });
});
