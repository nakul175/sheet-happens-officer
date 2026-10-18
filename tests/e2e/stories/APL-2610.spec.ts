// SHO-BUG-3 Changing the done section (or deleting a section into it) completes parents and leaves their subtasks open (Linear APL-2610).
// Acceptance criteria: AC1 done flag, AC2 Activity rows, AC3 delete into done, AC4 flag moved away, AC5 no reminder for a closed subtask.
// AC1 and AC3 allow either fix ("refused with a reason" OR "parent and both subtasks completed"), so each test accepts both and says which it saw.
// Tests marked [needs PR #6] check the reopen half, which is only fixed by PR #6 (src/lib/sections.ts reopenedSubtasks, src/lib/undo.ts).
// Covers Jim's PR #6 steps: (1) flag done, 3 complete + 3 rows; (2) flag back, 3 reopen; (3) undo, 3 close; (4) delete into done, 3 complete + 3 rows; plus the accepted pre-ticked subtask case.
// Run them on a build that has that PR; on main they fail by design, and that failure is the bug.
// AC5 note: the reminder job needs a job secret that a browser session does not have, so the test checks the input the job reads
// (src/lib/jobs.ts sendReminders only picks tasks with completedAt null): a closed subtask must be gone from the assignee's My tasks.
// Data: one ZZ-TEST project per test, archived afterwards. No people are created; the Super Admin holds the subtasks. No secret is read or printed.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;

/** A project, a parent in the Doing section and two open subtasks held by the Super Admin and due tomorrow. */
async function tree(admin: Who, later: Later, label: string) {
  const p = await newProject(admin, later, { label });
  const parent = await newTask(admin, p.id, { title: zz(`${label} parent`), sectionId: p.doing });
  const subs = [
    await newTask(admin, p.id, { title: zz(`${label} sub one`), parentId: parent, assigneeId: admin.user.id, dueDate: ymd(1) }),
    await newTask(admin, p.id, { title: zz(`${label} sub two`), parentId: parent, assigneeId: admin.user.id, dueDate: ymd(1) }),
  ];
  const titles = [zz(`${label} parent`), zz(`${label} sub one`), zz(`${label} sub two`)];
  return { p, parent, subs, all: [parent, ...subs], titles };
}

const isDone = async (admin: Who, id: string) => !!(await getTask(admin, id)).completedAt;
const states = async (admin: Who, ids: string[]) => Promise.all(ids.map((id) => isDone(admin, id)));
const completedRows = async (admin: Who, projectId: string) =>
  ((await admin.api.get(`/api/projects/${projectId}/activity`)).json.items as { what: string }[]).map((i) => i.what).filter((w) => /^completed /.test(w));
const inMyTasks = async (admin: Who, id: string) => JSON.stringify((await admin.api.get("/api/my-tasks")).json).includes(id);

/** AC1/AC3 outcome: either the change was refused and nothing closed, or all three closed. Returns which one happened. */
async function expectRefusedOrCascaded(admin: Who, t: Awaited<ReturnType<typeof tree>>, status: number, json: unknown) {
  if (status === 200 || status === 204) {
    expect(await states(admin, t.all), "parent and both subtasks are complete").toEqual([true, true, true]);
    return "cascade" as const;
  }
  expect([400, 409], `a refusal, not a crash: ${JSON.stringify(json)}`).toContain(status);
  expect(JSON.stringify(json), "the refusal gives a reason").toMatch(/\w{4,}/);
  expect(await states(admin, t.all), "refused means nothing closed").toEqual([false, false, false]);
  return "refused" as const;
}

test("AC1 + AC2: marking the section as the done section refuses with a reason, or completes parent and both subtasks with one completed row each", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 flag");
  const r = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  const outcome = await expectRefusedOrCascaded(admin, t, r.status, r.json);
  test.info().annotations.push({ type: "fix chosen", description: outcome });
  if (outcome === "cascade") {
    const rows = await completedRows(admin, t.p.id);
    expect(rows, "three completed rows in a fresh project: parent and two subtasks").toHaveLength(3);
    for (const title of t.titles) expect(rows.filter((w) => w.includes(title)), `exactly one completed row for "${title}"`).toHaveLength(1);
  }
});

test("AC3: deleting a section into the done section refuses with a reason, or completes parent and both subtasks with one completed row each", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 delete");
  const r = await admin.api.del(`/api/projects/${t.p.id}/sections/${t.p.doing}?moveTo=${t.p.done}`);
  const outcome = await expectRefusedOrCascaded(admin, t, r.status, r.json);
  test.info().annotations.push({ type: "fix chosen", description: outcome });
  if (outcome === "cascade") {
    expect((await getTask(admin, t.parent)).sectionId, "the parent now sits in the done section").toBe(t.p.done);
    const rows = await completedRows(admin, t.p.id);
    expect(rows, "three completed rows in a fresh project: parent and two subtasks").toHaveLength(3);
    for (const title of t.titles) expect(rows.filter((w) => w.includes(title)), `exactly one completed row for "${title}"`).toHaveLength(1);
  }
});

test("AC4 [needs PR #6]: moving the done flag away reopens the parent and the subtasks that closed with it", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 back");
  const on = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  test.skip((await expectRefusedOrCascaded(admin, t, on.status, on.json)) === "refused", "this build refuses the change (AC1 option 1), so there is nothing to reopen");
  const back = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { isDone: true });
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect(await isDone(admin, t.parent), "parent reopens").toBe(false);
  for (const s of t.subs) expect(await isDone(admin, s), "subtask reopens with its parent").toBe(false);
});

test("AC4 [needs PR #6]: undoing the move-back closes parent and subtasks again", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 undo");
  const first = await admin.page.request.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { data: { isDone: true } });
  test.skip(first.status() !== 200, "this build refuses the change (AC1 option 1), so there is nothing to undo");
  expect(await states(admin, t.all)).toEqual([true, true, true]);
  const back = await admin.page.request.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { data: { isDone: true } });
  expect(back.status()).toBe(200);
  expect(await states(admin, t.all), "after the move-back all three are open").toEqual([false, false, false]);
  const undoBack = back.headers()["x-undo-id"];
  expect(undoBack, "the move-back is undoable").toBeTruthy();
  expect((await admin.api.post(`/api/actions/${undoBack}/undo`, { anyway: false })).status).toBe(200);
  expect(await states(admin, t.all), "undo of the move-back closes all three again").toEqual([true, true, true]);
});

test("AC5: a subtask closed with its parent is no longer an open task for its holder, so the reminder job has nothing to send for it", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 remind");
  for (const s of t.subs) expect(await inMyTasks(admin, s), "control: an open subtask with a due date is in My tasks").toBe(true);
  const r = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  const outcome = await expectRefusedOrCascaded(admin, t, r.status, r.json);
  test.skip(outcome === "refused", "this build refuses the change (AC1 option 1); the subtasks stay open and reminders for them are correct");
  for (const s of t.subs) expect(await inMyTasks(admin, s), "a closed subtask is gone from My tasks, so no reminder").toBe(false);
});

test("AC4 [needs PR #6] (PENDING AC4 decision (NJ): asserts PR #6 behaviour, not the written AC): a subtask ticked done BEFORE its parent entered the done section also reopens with the parent", async ({ admin, later }) => {
  // Not a defect: Jim's notes for PR #6 accept that every done subtask of a reopened parent reopens (src/lib/sections.ts reopenedSubtasks),
  // including one that was completed on its own earlier. The AC4 wording "completed with them" is read loosely here.
  const t = await tree(admin, later, "bug3 preticked");
  expect((await admin.api.post(`/api/tasks/${t.subs[0]}/complete`)).status).toBe(200); // ticked on its own, parent still open
  expect(await states(admin, t.all)).toEqual([false, true, false]);
  const on = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  test.skip(on.status !== 200, "this build refuses the change (AC1 option 1), so nothing reopens");
  expect(await states(admin, t.all), "all three are complete after the change").toEqual([true, true, true]);
  const back = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { isDone: true });
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect(await states(admin, t.all), "parent, the pre-ticked subtask and the other subtask are all open").toEqual([false, false, false]);
});
