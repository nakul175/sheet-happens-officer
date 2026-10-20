// APL-2711. Undo stays available at exactly 30×24h. Purge removes Trash only when it is strictly older.
// Dwight, 2:11 AM 19 Oct 2026, NJ's decision.
// Database rows are ZZ-TEST data owned by a nakul17+ alias. Cleanup deletes only those rows.
// The purge calls are scoped, and the suite refuses any database that is not on localhost.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { Prisma } from "../src/generated/prisma/client";
import { db } from "../src/lib/db";
import { purgeTrash } from "../src/lib/tasks";
import { UNDO_WINDOW_MS, isTooOldToUndo, trashPurgeBefore } from "../src/lib/undoable";

const NOW = Date.parse("2026-10-19T02:11:00.000Z");
const EMAIL = "nakul17+apl2711@example.invalid";
const PREFIX = "ZZ-TEST-APL-2711";
const BOUNDARY = `${PREFIX}-boundary`;
const SCOPE: Prisma.TaskWhereInput = {
  title: { startsWith: BOUNDARY },
  createdBy: { email: EMAIL },
};
const CONCURRENCY = 48;

function assertLocalDatabase() {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error("Refusing the purge test: DATABASE_URL is missing or not a URL.");
  }
  if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error(`Refusing the purge test against ${host}.`);
  if (/prod|sheethappens/i.test(raw)) throw new Error("Refusing the purge test: DATABASE_URL looks like production.");
}

async function cleanup() {
  const user = await db.user.findUnique({ where: { email: EMAIL }, select: { id: true, workspaceId: true } });
  const projects = await db.project.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length || user) {
    await db.actionLog.deleteMany({
      where: { OR: [...(projectIds.length ? [{ projectId: { in: projectIds } }] : []), ...(user ? [{ actorId: user.id }, { undoneById: user.id }] : [])] },
    });
  }
  if (user) await db.notification.deleteMany({ where: { actorId: user.id } });
  await db.auditLog.deleteMany({ where: { event: "TASK_PURGED", data: { path: ["limited"], equals: "1" } } });
  if (user) await db.auditLog.deleteMany({ where: { actorId: user.id } });
  await db.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
  if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  if (user) {
    await db.user.delete({ where: { id: user.id } });
    await db.workspace.deleteMany({ where: { id: user.workspaceId, name: PREFIX, users: { none: {} }, projects: { none: {} } } });
  }
}

describe("undo window (APL-2711)", () => {
  it("is 30×24h, 2,592,000,000 ms", () => {
    expect(UNDO_WINDOW_MS).toBe(2_592_000_000);
    expect(UNDO_WINDOW_MS).toBe(30 * 86_400_000);
  });

  it("still allows Undo at 30d − 1 ms", () => {
    const at = new Date(NOW - UNDO_WINDOW_MS + 1);
    expect(NOW - at.getTime()).toBe(UNDO_WINDOW_MS - 1);
    expect(isTooOldToUndo(at, NOW)).toBe(false);
    expect(at.getTime() < trashPurgeBefore(NOW).getTime()).toBe(false);
  });

  it("still allows Undo at exactly 30d, and that instant is not purged", () => {
    const at = new Date(NOW - UNDO_WINDOW_MS);
    expect(NOW - at.getTime()).toBe(UNDO_WINDOW_MS);
    expect(isTooOldToUndo(at, NOW)).toBe(false);
    const cutoff = trashPurgeBefore(NOW);
    expect(cutoff.toISOString()).toBe(at.toISOString());
    expect(at.getTime() < cutoff.getTime()).toBe(false);
  });

  it("is too old to undo, and is purged, at 30d + 1 ms", () => {
    const at = new Date(NOW - UNDO_WINDOW_MS - 1);
    expect(NOW - at.getTime()).toBe(UNDO_WINDOW_MS + 1);
    expect(isTooOldToUndo(at, NOW)).toBe(true);
    expect(at.getTime() < trashPurgeBefore(NOW).getTime()).toBe(true);
  });
});

describe("trash purge boundary (APL-2711)", () => {
  it("purges only Trash strictly older than 30×24h, including 48 concurrent deletes", async () => {
    expect(CONCURRENCY).toBeGreaterThanOrEqual(40);
    assertLocalDatabase();
    await cleanup();
    const now = new Date(NOW);
    try {
      const ws = await db.workspace.create({ data: { name: PREFIX } });
      const user = await db.user.create({
        data: { workspaceId: ws.id, email: EMAIL, name: "ZZ-TEST APL-2711", passwordHash: "zz-test-not-a-real-password" },
      });
      const project = await db.project.create({
        data: {
          workspaceId: ws.id,
          name: PREFIX,
          members: { create: { userId: user.id, role: "LEADER" } },
          sections: { create: { name: PREFIX, position: 0 } },
        },
        include: { sections: true },
      });
      const sectionId = project.sections[0].id;
      const make = (title: string, deletedAt: Date) =>
        db.task.create({
          data: {
            workspaceId: ws.id,
            projectId: project.id,
            sectionId,
            title,
            assigneeId: user.id,
            createdById: user.id,
            deletedAt,
            deletedById: user.id,
          },
        });
      await make(`${BOUNDARY}-young`, new Date(NOW - UNDO_WINDOW_MS + 1));
      await make(`${BOUNDARY}-exact`, new Date(NOW - UNDO_WINDOW_MS));
      await make(`${BOUNDARY}-old`, new Date(NOW - UNDO_WINDOW_MS - 1));
      await make(`${PREFIX}-control`, new Date(NOW - UNDO_WINDOW_MS - 86_400_000));

      const foreignBefore = await db.task.findMany({
        where: { deletedAt: { lt: trashPurgeBefore(now) }, NOT: { title: { startsWith: PREFIX } } },
        select: { id: true },
      });

      expect(await purgeTrash(now, SCOPE)).toBe(1);
      const afterOne = new Set((await db.task.findMany({ where: { projectId: project.id }, select: { title: true } })).map((t) => t.title));
      expect(afterOne.has(`${BOUNDARY}-young`)).toBe(true);
      expect(afterOne.has(`${BOUNDARY}-exact`)).toBe(true);
      expect(afterOne.has(`${BOUNDARY}-old`)).toBe(false);
      expect(afterOne.has(`${PREFIX}-control`)).toBe(true);

      await make(`${BOUNDARY}-old`, new Date(NOW - UNDO_WINDOW_MS - 1));
      const counts = await Promise.all(Array.from({ length: CONCURRENCY }, () => purgeTrash(now, SCOPE)));
      expect(counts.every((n) => n === 0 || n === 1)).toBe(true);
      expect(counts.reduce((sum, n) => sum + n, 0)).toBe(1);

      const afterLoad = new Set((await db.task.findMany({ where: { projectId: project.id }, select: { title: true } })).map((t) => t.title));
      expect(afterLoad.has(`${BOUNDARY}-young`)).toBe(true);
      expect(afterLoad.has(`${BOUNDARY}-exact`)).toBe(true);
      expect(afterLoad.has(`${BOUNDARY}-old`)).toBe(false);
      expect(afterLoad.has(`${PREFIX}-control`)).toBe(true);
      for (const row of foreignBefore) {
        expect(await db.task.findUnique({ where: { id: row.id }, select: { id: true } })).not.toBeNull();
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});
