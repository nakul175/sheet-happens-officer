// APL-2719. A concierge card that moves a task to Trash starts its Undo clock at deletedAt, not after the
// card finished running, so the card never offers Undo for a task that purge can already remove.
// No qa:TC id is assigned on the issue, so every title carries qa:TC missing.
// ZZ-TEST person, project and task with a nakul17+ alias, made and cleaned up through the API (cleanupZz).
// Nothing is written to back-date a row. Each check injects 'now' at deletedAt + age: Vitest's fake Date for the
// card's Undo reads, and purgeTrash(now, { id }) scoped to the one task, so no other Trash is touched.
import { afterAll, describe, expect, it, vi } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, lastData, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { confirmCard, undoCard } from "../src/lib/concierge/cards";
import { thread } from "../src/lib/concierge/thread";
import type { Stored } from "../src/lib/concierge/types";
import { purgeTrash } from "../src/lib/tasks";
import { UNDO_DAYS } from "../src/lib/undoable";

const WINDOW = UNDO_DAYS * 86_400_000;
const DAY = 86_400_000;
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  vi.useRealTimers();
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST lead whose concierge card has moved one task to Trash. */
async function cardDeletedTask() {
  const n = seq++;
  const lead = await account(`ZZ-TEST Lead ${RUN}-${n}`, `nakul17+zz-2719c-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `APL-2719 card ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST card delete ${RUN}-${n}`;
  const taskId = await task(lead, projectId, { dueDate: "2031-03-20", title });
  script(
    () => [tu("find_tasks", { text: title })],
    (r) => [tu("propose_changes", { changes: [{ action: "delete_task", task_id: lastData(r).tasks[0].id }] })],
  );
  const asked = await sendMessage(actor(lead), `Move ${title} to Trash`);
  const card = asked.messages.find((m) => m.kind === "card")!;
  const done = await confirmCard(actor(lead), card.id);
  const resultId = done.messages[0].id;
  return { lead, taskId, cardId: card.id, resultId };
}

const storedOf = async (id: string) => JSON.parse((await db.chatMessage.findUniqueOrThrow({ where: { id } })).content) as Stored;

describe("qa:TC missing APL-2719 concierge card Undo and purge share one timestamp", () => {
  useFakeModel();

  it("qa:TC missing AC1: the card's Undo clock (confirmedAt) is the task's deletedAt to the millisecond", async () => {
    const { taskId, cardId, resultId } = await cardDeletedTask();
    const t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const log = await db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId } });
    expect(t.deletedAt).not.toBeNull();
    expect(log.channel).toBe("CONCIERGE");
    expect(log.createdAt.getTime()).toBe(t.deletedAt!.getTime());
    expect(Date.parse((await storedOf(resultId)).internal!.confirmedAt!)).toBe(t.deletedAt!.getTime());
    expect(Date.parse((await storedOf(cardId)).internal!.confirmedAt!)).toBe(t.deletedAt!.getTime());
  });

  it("qa:TC missing AC2: on day 29, day 30 (exactly 30x24h) and day 31 the card never offers Undo for a task purge can remove", async () => {
    for (const age of [29 * DAY, WINDOW, WINDOW + 1, 31 * DAY]) {
      const c = await cardDeletedTask();
      const t = await db.task.findUniqueOrThrow({ where: { id: c.taskId } });
      const now = new Date(t.deletedAt!.getTime() + age);
      vi.useFakeTimers({ now, toFake: ["Date"] });
      try {
        const shown = (await thread(actor(c.lead))).find((m) => m.kind === "result" && m.result?.cardId === c.cardId)!;
        const showsUndo = shown.result!.undoable && !shown.result!.undoExpired && !shown.result!.undoneAt;
        if (!showsUndo) {
          await expect(undoCard(actor(c.lead), c.cardId)).rejects.toMatchObject({ status: 409, message: "Too old to undo" });
        }
        await purgeTrash(now, { id: c.taskId });
        const purged = !(await db.task.findUnique({ where: { id: c.taskId } }));
        expect({ age, purged, undoOffered: showsUndo }).toEqual({ age, purged: age > WINDOW, undoOffered: age <= WINDOW });
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
