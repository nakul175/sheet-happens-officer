// Scheduled-job notices (SHO-US-9.3 AC6, SHO-BUG-1). Runs the job runner in this one process, as the server does:
// each failing job must reach the Super Admin's bell, and the same job failing again within 20 hours adds nothing.
import { describe, expect, it } from "vitest";
import { account, istDate, project, superAdmin, task } from "./helpers";
import { db } from "./concierge-helpers";
import { JOBS, runJob, sendReminders } from "../src/lib/jobs";

describe("job failure notices (9.3 AC6)", () => {
  it("tells the Super Admin about every failing job, once per job per day, within one process", async () => {
    const sa = await superAdmin();
    const stamp = Date.now();
    const names = [`test-fail-a-${stamp}`, `test-fail-b-${stamp}`];
    for (const name of names) JOBS.push({ name, about: "Test job that always fails", run: async () => { throw new Error(`${name} broke`); } });
    const notices = async () => (await db.notification.findMany({ where: { recipientId: sa.id, type: "JOB_FAILED", createdAt: { gte: new Date(stamp - 1000) } }, select: { data: true } }))
      .map((n) => (n.data as { job: string }).job).filter((j) => names.includes(j)).sort();
    try {
      await expect(runJob(names[0])).rejects.toMatchObject({ status: 500 });
      await expect(runJob(names[1])).rejects.toMatchObject({ status: 500 });
      expect(await notices()).toEqual(names); // one notice per job, not one per process
      expect((await db.jobRun.findUniqueOrThrow({ where: { job: names[1] } })).lastStatus).toBe("FAILED");
      await expect(runJob(names[0])).rejects.toMatchObject({ status: 500 });
      expect(await notices()).toEqual(names); // the same job again within 20 hours: nothing new
      const bell = (await sa.c.get("/api/notifications")).json.items as { text: string; href: string }[];
      for (const name of names) expect(bell.find((n) => n.text.includes(`"${name}" failed: ${name} broke`))?.href).toBe("/audit");
    } finally {
      for (const name of names) JOBS.splice(JOBS.findIndex((j) => j.name === name), 1);
      await db.jobRun.deleteMany({ where: { job: { in: names } } });
      await db.notification.deleteMany({ where: { type: "JOB_FAILED", data: { path: ["job"], string_starts_with: "test-fail-" } } });
    }
  });
});

describe("due reminders and subtasks (APL-2610 AC5)", () => {
  it("sends no reminder for a subtask with a due date that closed with its parent, while an open one gets it", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const dueTomorrow = istDate(1);
    // A subtask due tomorrow that closes with its parent (cascade), and a control subtask, also due tomorrow, under an open parent.
    const parent = await task(lead, p.id, { title: "Parent" });
    const closed = await task(lead, p.id, { parentId: parent, title: "Closed with parent", dueDate: dueTomorrow });
    const other = await task(lead, p.id, { title: "Open parent" });
    const open = await task(lead, p.id, { parentId: other, title: "Still open", dueDate: dueTomorrow });
    expect((await lead.c.post(`/api/tasks/${parent}/complete`, { completeAll: true })).status).toBe(200);
    const sub = await db.task.findUniqueOrThrow({ where: { id: closed } });
    expect(sub.completedAt).not.toBeNull();
    expect(sub.completedWithParent).toBe(true);

    await sendReminders();
    const sent = async (taskId: string) => db.notification.count({ where: { taskId, type: { in: ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] } } });
    expect(await sent(open)).toBe(1); // the job ran and does remind an open subtask due tomorrow
    expect(await sent(closed)).toBe(0); // nothing for the one that closed with its parent
  });
});
