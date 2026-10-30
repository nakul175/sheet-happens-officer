// APL-2718. The scheduled purge-trash job removes expired Trash in every workspace.
// No signed-in route or concierge action calls purgeTrash or runJob("purge-trash"). Test only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/lib/auth";
import { runJob } from "../src/lib/jobs";
import { BASE, Client, PW } from "./helpers";

const db = new PrismaClient();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;
// Fixed clock for the seed and for the scheduled job. purgeTrash() reads `new Date()`
// and the job passes no argument, so the job runs with Date faked to this instant.
// 1990 keeps every other row in the test database outside the 30-day window.
const CLOCK = new Date("1990-06-15T12:00:00.000Z");

type Side = {
  label: "A" | "B";
  workspaceId: string;
  projectId: string;
  userId: string;
  email: string;
  expiredId: string;
  recentId: string;
};

type Seed = { A: Side; B: Side; now: Date };

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx|js|mjs|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** A direct purgeTrash use, or a call that runs the scheduled purge by name. */
const USER_PURGE = /\bpurgeTrash\b|\brunJob\s*\(\s*['"`]purge-trash['"`]/;

/** Files whose code (not comments) would purge Trash from a user-reachable module. */
function userPurgeCallers(dir: string) {
  return filesUnder(dir)
    .filter((file) => USER_PURGE.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => path.relative(root, file));
}

async function seedWorkspaces(): Promise<Seed> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const passwordHash = await hashPassword(PW);
  const verifiedAt = new Date();
  const expiredAt = new Date(CLOCK.getTime() - 31 * DAY);
  const recentAt = new Date(CLOCK.getTime() - 1 * DAY);
  return db.$transaction(async (tx) => {
    const side = async (label: "A" | "B"): Promise<Side> => {
      const workspace = await tx.workspace.create({ data: { name: `ZZ-TEST workspace ${label}` } });
      const email = `zz-test-purge-2718-${label.toLowerCase()}-${stamp}@aplyd.com`;
      const user = await tx.user.create({
        data: {
          workspaceId: workspace.id,
          email,
          name: `ZZ-TEST Purge ${label}`,
          passwordHash,
          emailVerifiedAt: verifiedAt,
          // ADMIN is the highest role a ZZ-TEST address can hold. Super Admin is
          // SUPER_ADMIN_EMAILS only, and sign-in demotes any other address.
          // An Admin acts as Leader on every project, including the other workspace.
          orgRole: label === "A" ? "ADMIN" : "MEMBER",
        },
      });
      const project = await tx.project.create({
        data: { workspaceId: workspace.id, name: `ZZ-TEST purge project ${label}`, description: "APL-2718" },
      });
      const section = await tx.section.create({
        data: { projectId: project.id, name: "To do", position: 0, isDone: false },
      });
      await tx.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "LEADER" } });
      const task = (title: string, deletedAt: Date) =>
        tx.task.create({
          data: {
            workspaceId: workspace.id,
            projectId: project.id,
            sectionId: section.id,
            title,
            assigneeId: user.id,
            createdById: user.id,
            deletedAt,
            deletedById: user.id,
          },
        });
      const expired = await task(`ZZ-TEST expired ${label}`, expiredAt);
      const recent = await task(`ZZ-TEST recent ${label}`, recentAt);
      return { label, workspaceId: workspace.id, projectId: project.id, userId: user.id, email, expiredId: expired.id, recentId: recent.id };
    };
    return { A: await side("A"), B: await side("B"), now: CLOCK };
  });
}

async function discard(seed: Seed, auditIds: string[]) {
  const userIds = [seed.A.userId, seed.B.userId];
  const projectIds = [seed.A.projectId, seed.B.projectId];
  const workspaceIds = [seed.A.workspaceId, seed.B.workspaceId];
  if (auditIds.length) await db.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await db.task.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await db.actionLog.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { actorId: { in: userIds } }] } });
  await db.notification.deleteMany({ where: { OR: [{ recipientId: { in: userIds } }, { actorId: { in: userIds } }] } });
  await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await db.loginAttempt.deleteMany({ where: { email: { in: [seed.A.email, seed.B.email] } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
}

type Row = { id: string; workspaceId: string; title: string; deletedAt: string | null; updatedAt: string };

async function rows(ids: string[]): Promise<Row[]> {
  const found = await db.task.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  return found.map((t) => ({
    id: t.id,
    workspaceId: t.workspaceId,
    title: t.title,
    deletedAt: t.deletedAt?.toISOString() ?? null,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

describe("purgeTrash scope (APL-2718)", () => {
  it("AC1 @static no API file calls purgeTrash or runJob('purge-trash') (APL-2718-AC1@v1)", () => {
    const api = path.join(root, "src/app/api");
    expect(readdirSync(api).length).toBeGreaterThan(0);
    expect(userPurgeCallers(api)).toEqual([]);
    expect(userPurgeCallers(path.join(root, "src/app/(app)/projects/[id]/trash"))).toEqual([]);
  });

  it("AC1 a signed-in user of workspace A does not change workspace B (APL-2718-AC1@v1)", async () => {
    const seed = await seedWorkspaces();
    const ids = [seed.A.expiredId, seed.A.recentId, seed.B.expiredId, seed.B.recentId];
    try {
      const before = await rows(ids);
      expect(before).toHaveLength(4);
      const c = new Client();
      const signed = await c.post("/api/auth/signin", { email: seed.A.email, password: PW });
      expect(signed.status, JSON.stringify(signed.json)).toBe(200);
      expect(signed.json.user.orgRole).toBe("ADMIN");
      expect(signed.json.user.id).toBe(seed.A.userId);

      const mine = await c.get(`/api/projects/${seed.A.projectId}`);
      const other = await c.get(`/api/projects/${seed.B.projectId}`);
      expect(mine.status, JSON.stringify(mine.json)).toBe(200);
      expect(other.status, JSON.stringify(other.json)).toBe(200);
      expect(mine.json.project.role).toBe("LEADER");
      expect(other.json.project.role).toBe("LEADER");

      const trashA = await c.get(`/api/projects/${seed.A.projectId}/trash`);
      const trashB = await c.get(`/api/projects/${seed.B.projectId}/trash`);
      expect(trashA.status).toBe(200);
      expect(trashB.status).toBe(200);
      expect((trashB.json.items as { id: string }[]).map((item) => item.id).sort()).toEqual([seed.B.expiredId, seed.B.recentId].sort());

      const secret = process.env.JOB_SECRET ?? "";
      const wrong = (secret.startsWith("y") ? "x" : "y").repeat(Math.max(16, secret.length));
      const asUser = (authorization?: string) =>
        fetch(`${BASE}/api/jobs/purge-trash`, {
          method: "POST",
          headers: { cookie: c.cookie, "content-type": "application/json", ...(authorization ? { authorization } : {}) },
          body: "{}",
        });
      expect((await asUser()).status).toBe(401);
      expect((await asUser(`Bearer ${wrong}`)).status).toBe(401);

      const after = await rows(ids);
      expect(after).toEqual(before);
      const workspaceB = after.filter((row) => row.workspaceId === seed.B.workspaceId);
      expect(workspaceB).toHaveLength(2);
      expect(workspaceB.every((row) => row.deletedAt)).toBe(true);
    } finally {
      await discard(seed, []);
    }
  });

  it("AC2 the scheduled purge-trash job removes 31-day trash in every workspace (APL-2718-AC2@v1)", async () => {
    const seed = await seedWorkspaces();
    const previous = await db.jobRun.findUnique({ where: { job: "purge-trash" } });
    const prior = new Set((await db.auditLog.findMany({ where: { event: "TASK_PURGED" }, select: { id: true } })).map((row) => row.id));
    const auditIds: string[] = [];
    let out: Awaited<ReturnType<typeof runJob>> | undefined;
    try {
      vi.useFakeTimers({ now: CLOCK, toFake: ["Date"] });
      out = await runJob("purge-trash");
    } finally {
      vi.useRealTimers();
    }
    try {
      expect(out).toEqual({ job: "purge-trash", status: "OK", result: 2 });
      const started = await db.jobRun.findUniqueOrThrow({ where: { job: "purge-trash" } });
      expect(started.lastStartedAt?.toISOString()).toBe(CLOCK.toISOString());

      const created = await db.auditLog.findMany({
        where: { event: "TASK_PURGED", id: { notIn: [...prior] } },
        orderBy: { createdAt: "asc" },
      });
      expect(created).toHaveLength(1);
      expect(created[0]?.data).toEqual({ count: 2 });
      auditIds.push(...created.map((row) => row.id));

      expect(await db.task.findUnique({ where: { id: seed.A.expiredId } })).toBeNull();
      expect(await db.task.findUnique({ where: { id: seed.B.expiredId } })).toBeNull();
      const recentA = await db.task.findUniqueOrThrow({ where: { id: seed.A.recentId } });
      const recentB = await db.task.findUniqueOrThrow({ where: { id: seed.B.recentId } });
      expect(recentA.workspaceId).toBe(seed.A.workspaceId);
      expect(recentB.workspaceId).toBe(seed.B.workspaceId);
      expect(recentA.deletedAt?.toISOString()).toBe(new Date(CLOCK.getTime() - DAY).toISOString());
      expect(recentB.deletedAt?.toISOString()).toBe(new Date(CLOCK.getTime() - DAY).toISOString());
      expect(recentA.title).toBe("ZZ-TEST recent A");
      expect(recentB.title).toBe("ZZ-TEST recent B");
    } finally {
      if (previous) {
        await db.jobRun.update({
          where: { job: "purge-trash" },
          data: {
            lastStartedAt: previous.lastStartedAt,
            lastFinishedAt: previous.lastFinishedAt,
            lastStatus: previous.lastStatus,
            lastError: previous.lastError,
          },
        });
      } else {
        await db.jobRun.deleteMany({ where: { job: "purge-trash" } });
      }
      await discard(seed, auditIds);
    }
  });

  it("AC3 the change is a new test file and does not hide a product defect (APL-2718-AC3@v1)", () => {
    const self = readFileSync(new URL("./purge-scope-2718.test.ts", import.meta.url), "utf8");
    const dot = ".";
    const markers = ["it", "test", "describe"].flatMap((name) =>
      ["skip", "fail", "fails", "fixme"].map((kind) => name + dot + kind),
    );
    for (const marker of markers) expect(self.includes(marker), marker).toBe(false);
  });
});
