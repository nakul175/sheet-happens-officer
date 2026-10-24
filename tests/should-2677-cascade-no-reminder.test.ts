// SHO-2677 (APL-2610 AC5). A subtask that closed *with* its parent - the cascade a parent's
// "complete all" writes - must get no reminder. The reminder job (src/lib/jobs.ts sendReminders,
// via reminderTaskWhere) reads only tasks with `completedAt: null`, so the cascade's own write is
// what excludes it.
// The test asserts both directions in ONE job run, so it cannot pass vacuously: an ordinary
// top-level task and an open subtask of another parent, both due tomorrow and both held by the same
// person, must each get exactly one due-tomorrow reminder, while the two cascaded subtasks get none.
// The open subtask is the second direction that matters: an open subtask is eligible for a reminder,
// so the cascaded pair are excluded for being closed, not for being subtasks.
// Setup goes through the app API, as tests/should-2671-reopen-subtasks.test.ts does. The job is
// POSTed with JOB_SECRET the way tests/jobs-reminders-race.test.ts posts it, and the rows are read
// back in the test database with the job's own client (src/lib/db.ts). Names are ZZ-TEST, addresses
// are nakul17+ aliases. The secret is read from the environment and never printed.
// No qa:TC id is assigned on the issue, so every title says qa:TC missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { BASE, istDate, task, withVersion, type Account } from "./helpers";
import { zzTestData, type ZzProject } from "./zz-test-data";

const DUE = ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] as const;
type BellItem = { text: string; href: string | null };

const zz = zzTestData("2677");

let lead: Account;
let holder: Account;
let proj: ZzProject;

/** POST /api/jobs/reminders with the shared server's job token. The token is never printed. */
async function postReminders() {
  const secret = process.env.JOB_SECRET ?? "";
  expect(secret.length, "JOB_SECRET (the shared test server's job token) is required").toBeGreaterThanOrEqual(16);
  const res = await fetch(`${BASE}/api/jobs/reminders`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  expect(res.status, text.replaceAll(secret, "[redacted]").slice(0, 180)).toBe(200);
  expect((JSON.parse(text) as { status?: string }).status).toBe("OK");
}

/** The reminder rows the job wrote for this holder on these tasks. */
async function dueRows(taskIds: string[]) {
  return db.notification.findMany({
    where: { recipientId: holder.id, type: { in: [...DUE] }, taskId: { in: taskIds } },
    select: { type: true, taskId: true, data: true },
  });
}

/** completedAt as the page reads it. */
async function completedAt(id: string) {
  const res = await lead.c.get(`/api/tasks/${id}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.task.completedAt as string | null;
}

/** The reminder bell items that link to a task. The assignment notice for the same task is not one. */
async function reminderBellFor(id: string) {
  const res = await holder.c.get("/api/notifications?limit=200");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.items as BellItem[])
    .filter((item) => item.href === `/tasks/${id}` && /^".*" is (due tomorrow|due today|overdue)\b/.test(item.text));
}

beforeAll(async () => {
  lead = await zz.person("lead");
  holder = await zz.person("holder");
  proj = await zz.project(lead);
  const added = await lead.c.post(`/api/projects/${proj.id}/members`, { userId: holder.id, role: "EDITOR" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  // The holder is new, so a clean slate makes the count below mean what it says.
  await db.notification.deleteMany({ where: { recipientId: holder.id } });
}, 120_000);

afterAll(async () => {
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 120_000);

describe("qa:TC missing SHO-2677 AC5: a cascaded subtask gets no reminder", () => {
  it("qa:TC missing a parent completed with completeAll reminds the open tasks and none of the cascaded subtasks", async () => {
    const stamp = Date.now();
    const parent = await task(lead, proj.id, { title: `ZZ-TEST cascaded parent ${stamp}`, sectionId: proj.doing });
    const cascaded = [
      await task(lead, proj.id, { title: `ZZ-TEST cascaded one ${stamp}`, parentId: parent, assigneeId: holder.id, dueDate: istDate(1) }),
      await task(lead, proj.id, { title: `ZZ-TEST cascaded two ${stamp}`, parentId: parent, assigneeId: holder.id, dueDate: istDate(1) }),
    ];
    // Both held by the same person and due tomorrow, so each would be reminded if it were open.
    const openParent = await task(lead, proj.id, { title: `ZZ-TEST open parent ${stamp}`, sectionId: proj.doing });
    const openSub = await task(lead, proj.id, { title: `ZZ-TEST open subtask ${stamp}`, parentId: openParent, assigneeId: holder.id, dueDate: istDate(1) });
    const plain = await task(lead, proj.id, { title: `ZZ-TEST ordinary ${stamp}`, assigneeId: holder.id, dueDate: istDate(1) });

    // The cascade: the parent completes and closes both open subtasks with it.
    const closed = await lead.c.post(`/api/tasks/${parent}/complete`, await withVersion(lead, parent, { completeAll: true }));
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    for (const id of [parent, ...cascaded]) expect(await completedAt(id), `${id} closed with the parent`).not.toBeNull();
    for (const id of [openParent, openSub, plain]) expect(await completedAt(id), `${id} left open`).toBeNull();

    await postReminders();

    // Negative direction, per task so a failure names the cascaded subtask it is about.
    for (const id of cascaded) {
      expect(await dueRows([id]), `no reminder row for the cascaded subtask ${id}`).toEqual([]);
      expect(await reminderBellFor(id), `no bell item for the cascaded subtask ${id}`).toEqual([]);
    }
    // Positive direction, from the same run: the ordinary task and the open subtask.
    const open = [
      { id: openSub, title: `ZZ-TEST open subtask ${stamp}` },
      { id: plain, title: `ZZ-TEST ordinary ${stamp}` },
    ];
    for (const { id, title } of open) {
      expect(await dueRows([id]), `one reminder row for the still-open task ${id}`).toEqual([
        { type: "TASK_DUE_TOMORROW", taskId: id, data: { title } },
      ]);
      expect((await reminderBellFor(id)).map((item) => item.text), `the bell item for ${id}`).toEqual([`"${title}" is due tomorrow.`]);
    }
    // And nothing else: the run wrote exactly these two rows for the holder.
    expect((await dueRows([...cascaded, openSub, plain])).map((row) => `${row.taskId}|${row.type}`).sort())
      .toEqual([`${openSub}|TASK_DUE_TOMORROW`, `${plain}|TASK_DUE_TOMORROW`].sort());
  }, 120_000);
});
