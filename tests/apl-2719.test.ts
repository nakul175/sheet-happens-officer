// APL-2719. Delete writes Task.deletedAt and the task.deleted ActionLog.createdAt from one instant,
// so Undo age and purge age are measured from the same point.
// No qa:TC id is assigned on the issue, so every title carries qa:TC missing.
// Rows are ZZ-TEST data in their own workspace and are removed afterwards. The aged rows sit in 1985,
// so purgeTrash(CLOCK) can only reach rows deleted before 1985: nothing real is in that range.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Actor } from "../src/lib/access";
import { projectActivity } from "../src/lib/feed";
import { deleteTask, purgeTrash } from "../src/lib/tasks";
import { checkUndo } from "../src/lib/undo";
import { UNDO_DAYS } from "../src/lib/undoable";

const db = new PrismaClient();
const WINDOW = UNDO_DAYS * 86_400_000;
const CLOCK = new Date("1985-06-15T12:00:00.000Z");
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

let workspaceId = "";
let projectId = "";
let sectionId = "";
let user: Actor;

beforeAll(async () => {
  const ws = await db.workspace.create({ data: { name: `ZZ-TEST APL-2719 ${STAMP}` } });
  workspaceId = ws.id;
  const u = await db.user.create({
    data: { workspaceId, email: `nakul17+zz-2719-${STAMP}@aplyd.com`, name: `ZZ-TEST Leader ${STAMP}`, passwordHash: "x", emailVerifiedAt: new Date() },
  });
  user = { id: u.id, orgRole: u.orgRole, name: u.name };
  const p = await db.project.create({ data: { workspaceId, name: `ZZ-TEST APL-2719 ${STAMP}`, description: "APL-2719" } });
  projectId = p.id;
  sectionId = (await db.section.create({ data: { projectId, name: "To do", position: 0, isDone: false } })).id;
  await db.projectMember.create({ data: { projectId, userId: u.id, role: "LEADER" } });
});

afterAll(async () => {
  vi.useRealTimers();
  if (!workspaceId) return;
  await db.task.deleteMany({ where: { workspaceId } });
  await db.actionLog.deleteMany({ where: { OR: [{ projectId }, { actorId: user.id }] } });
  await db.notification.deleteMany({ where: { OR: [{ recipientId: user.id }, { actorId: user.id }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ actorId: user.id }, { event: "TASK_PURGED", createdAt: { lt: new Date("1986-01-01") } }] } });
  await db.project.deleteMany({ where: { id: projectId } });
  await db.user.deleteMany({ where: { id: user.id } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.$disconnect();
});

const newTask = (title: string, parentId?: string) =>
  db.task.create({ data: { workspaceId, projectId, sectionId, title: `ZZ-TEST ${title} ${STAMP}`, assigneeId: user.id, createdById: user.id, parentId } });

const deleteRow = (taskId: string) => db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId } });

/** Deletes a fresh task through deleteTask, then moves both stamps back by the same amount so the task is `age` ms old at CLOCK. */
async function deletedAged(age: number) {
  const t = await newTask(`aged ${age}`);
  await deleteTask(user, t.id);
  const task = await db.task.findUniqueOrThrow({ where: { id: t.id } });
  const log = await deleteRow(t.id);
  const shift = task.deletedAt!.getTime() - (CLOCK.getTime() - age);
  await db.task.update({ where: { id: t.id }, data: { deletedAt: new Date(task.deletedAt!.getTime() - shift) } });
  await db.actionLog.update({ where: { id: log.id }, data: { createdAt: new Date(log.createdAt.getTime() - shift) } });
  return { taskId: t.id, logId: log.id };
}

describe("qa:TC missing APL-2719 delete, Undo and purge share one timestamp", () => {
  it("qa:TC missing AC1: the task.deleted log row is stamped with the exact deletedAt of the task", async () => {
    const parent = await newTask("parent");
    const child = await newTask("child", parent.id);
    await deleteTask(user, parent.id);
    const [p, c, log] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: parent.id } }),
      db.task.findUniqueOrThrow({ where: { id: child.id } }),
      deleteRow(parent.id),
    ]);
    expect(p.deletedAt).not.toBeNull();
    expect(log.createdAt.getTime()).toBe(p.deletedAt!.getTime());
    expect(c.deletedAt!.getTime()).toBe(p.deletedAt!.getTime());
    expect((log.afterState as { deletedAt: string }).deletedAt).toBe(p.deletedAt!.toISOString());
  });

  it("qa:TC missing AC1: the shared stamp is the time of the delete, not a later or earlier one", async () => {
    const t = await newTask("other");
    const before = Date.now();
    await deleteTask(user, t.id);
    const log = await deleteRow(t.id);
    expect(log.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(log.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("qa:TC missing AC2: on day 29, day 30 (exactly 30x24h) and day 31, and 1-4 ms either side of 30 days, the task is never purged while Undo is still offered", async () => {
    // 30d + 1..4 ms is the window the late log row left open. Exactly 30x24h keeps Undo and is not purged
    // (APL-2711 AC v1.1: Undo at 30 days or less, purge only when older than 30 days).
    const DAY = 86_400_000;
    const ages = [29 * DAY, WINDOW - 1, WINDOW, WINDOW + 1, WINDOW + 2, WINDOW + 3, WINDOW + 4, 31 * DAY];
    const rows = [];
    for (const age of ages) rows.push({ age, ...(await deletedAged(age)) });

    vi.useFakeTimers({ now: CLOCK, toFake: ["Date"] });
    try {
      const activity = await projectActivity(user, projectId, undefined, 200);
      const offered = new Map<string, boolean>();
      for (const r of rows) {
        const item = activity.items.find((i) => i.id === r.logId);
        expect(item, `activity row for age ${r.age}`).toBeDefined();
        const apiAllows = await checkUndo(user, r.logId).then(() => true, (e: { message?: string }) => {
          expect(e.message).toBe("Too old to undo");
          return false;
        });
        expect(item!.undo === "available", `feed and API agree at age ${r.age}`).toBe(apiAllows);
        offered.set(r.taskId, apiAllows);
      }
      await purgeTrash(CLOCK);
      for (const r of rows) {
        const purged = !(await db.task.findUnique({ where: { id: r.taskId } }));
        expect({ age: r.age, purged, undoOffered: offered.get(r.taskId) }).toEqual({ age: r.age, purged: r.age > WINDOW, undoOffered: r.age <= WINDOW });
        expect(purged && offered.get(r.taskId), `purged while Undo offered at age ${r.age}`).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
