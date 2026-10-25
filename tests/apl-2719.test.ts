// APL-2719. Delete writes Task.deletedAt and the task.deleted ActionLog.createdAt from one instant,
// so Undo age and purge age are measured from the same point.
// No qa:TC id is assigned on the issue, so every title carries qa:TC missing.
// A ZZ-TEST person, project and tasks are made through the API and cleaned up through it (cleanupZz).
// Nothing is written to back-date a row. Each check runs with 'now' injected at deletedAt + age: Vitest's fake Date
// for the Undo reads, and purgeTrash(now, { id }) scoped to the one task, so no other Trash is touched.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Actor } from "../src/lib/access";
import { projectActivity } from "../src/lib/feed";
import { deleteTask, listTrash, purgeTrash } from "../src/lib/tasks";
import { checkUndo } from "../src/lib/undo";
import { UNDO_DAYS } from "../src/lib/undoable";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";

const db = new PrismaClient();
const WINDOW = UNDO_DAYS * 86_400_000;
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`;

let lead: Account;
let projectId = "";
let user: Actor;

beforeAll(async () => {
  lead = await account(`ZZ-TEST Leader ${STAMP}`, `nakul17+zz-2719u-${STAMP}@aplyd.com`);
  user = { id: lead.id, orgRole: "MEMBER", name: lead.name };
  projectId = await zzProject(lead, `APL-2719 ${STAMP}`);
});

afterAll(async () => {
  vi.useRealTimers();
  if (lead) await cleanupZz(projectId ? [projectId] : [], [lead]);
  await db.$disconnect();
});

const newTask = async (title: string, parentId?: string) => ({ id: await task(lead, projectId, { title: `ZZ-TEST ${title} ${STAMP}`, ...(parentId ? { parentId } : { dueDate: "2031-03-20" }) }) });

const deleteRow = (taskId: string) => db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId } });

/** Deletes a fresh task through deleteTask and returns the instant to inject: deletedAt + age. */
async function deletedAt(age: number) {
  const t = await newTask(`aged ${age}`);
  await deleteTask(user, t.id);
  const row = await db.task.findUniqueOrThrow({ where: { id: t.id } });
  const log = await deleteRow(t.id);
  return { taskId: t.id, logId: log.id, now: new Date(row.deletedAt!.getTime() + age) };
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
    for (const age of ages) {
      const r = await deletedAt(age);
      vi.useFakeTimers({ now: r.now, toFake: ["Date"] });
      try {
        const item = (await projectActivity(user, projectId, undefined, 200)).items.find((i) => i.id === r.logId);
        expect(item, `activity row for age ${age}`).toBeDefined();
        const apiAllows = await checkUndo(user, r.logId).then(() => true, (e: { message?: string }) => {
          expect(e.message).toBe("Too old to undo");
          return false;
        });
        expect(item!.undo === "available", `feed and API agree at age ${age}`).toBe(apiAllows);
        const left = (await listTrash(user, projectId)).find((x) => x.id === r.taskId)?.daysLeft;
        if (age === 29 * DAY) expect(left).toBe(1);
        if (age === 31 * DAY) expect(left).toBe(0);
        await purgeTrash(r.now, { id: r.taskId });
        const purged = !(await db.task.findUnique({ where: { id: r.taskId } }));
        expect({ age, purged, undoOffered: apiAllows }).toEqual({ age, purged: age > WINDOW, undoOffered: age <= WINDOW });
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
