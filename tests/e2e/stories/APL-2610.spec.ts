// SHO-BUG-3 Changing the done section (or deleting a section into it) completes parents and leaves their subtasks open (Linear APL-2610).
// Acceptance criteria: AC1 done flag, AC2 Activity rows, AC3 delete into done, AC4 flag moved away, AC5 no reminder for a closed subtask.
// AC1 and AC3 allow either fix ("refused with a reason" OR "parent and both subtasks completed"), so each test accepts both and says which it saw.
// The reopen half is the done-flag move back, Undo of that move, a pre-ticked subtask, and reopening a parent.
// Covers: (1) flag done, 3 complete + 3 rows; (2) flag back, 3 reopen; (3) undo, 3 close; (4) delete into done, 3 complete + 3 rows; plus the pre-ticked subtask case (AC4 as reworded by APL-2671).
// AC5 note: the reminder job needs a job secret that a browser session does not have, so the test checks the input the job reads
// (src/lib/jobs.ts sendReminders only picks tasks with completedAt null): a closed subtask must be gone from the assignee's My tasks.
// Data: one ZZ-TEST project per test, archived afterwards. No people are created; the Super Admin holds the subtasks. No secret is read or printed.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;

/** A project, a parent in the Doing section and two open subtasks held by the Super Admin and due tomorrow. */
async function tree(admin: Who, later: Later, label: string) {
  const p = await newProject(admin, later, { label });
  const parent = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz(`${label} parent`), sectionId: p.doing });
  const subs = [
    await newTask(admin, p.id, { title: zz(`${label} sub one`), parentId: parent, assigneeId: admin.user.id, dueDate: ymd(1) }),
    await newTask(admin, p.id, { title: zz(`${label} sub two`), parentId: parent, assigneeId: admin.user.id, dueDate: ymd(1) }),
  ];
  const titles = [zz(`${label} parent`), zz(`${label} sub one`), zz(`${label} sub two`)];
  return { p, parent, subs, all: [parent, ...subs], titles };
}

/** Complete on the task's current version. Staging requires expectedUpdatedAt. */
async function finish(admin: Who, id: string, body: Record<string, unknown> = {}) {
  const seen = (await getTask(admin, id)).updatedAt as string;
  return admin.api.post(`/api/tasks/${id}/complete`, { ...body, expectedUpdatedAt: seen });
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

test("AC4: moving the done flag away reopens the parent and the subtasks that closed with it", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 back");
  const on = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  if ((await expectRefusedOrCascaded(admin, t, on.status, on.json)) === "refused") {
    expect(await states(admin, t.all), "a refusal leaves every task open, so there is nothing to reopen").toEqual([false, false, false]);
    return;
  }
  const back = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { isDone: true });
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect(await isDone(admin, t.parent), "parent reopens").toBe(false);
  for (const s of t.subs) expect(await isDone(admin, s), "subtask reopens with its parent").toBe(false);
});

test("AC4: undoing the move-back closes parent and subtasks again", async ({ admin, later }) => {
  const t = await tree(admin, later, "bug3 undo");
  const first = await admin.page.request.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { data: { isDone: true } });
  if (first.status() !== 200) {
    expect(await states(admin, t.all), "a refusal leaves every task open").toEqual([false, false, false]);
    return;
  }
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
  if (outcome === "refused") {
    for (const s of t.subs) expect(await inMyTasks(admin, s), "a refusal leaves the open subtask in My tasks").toBe(true);
    return;
  }
  for (const s of t.subs) expect(await inMyTasks(admin, s), "a closed subtask is gone from My tasks, so no reminder").toBe(false);
});

test("AC4 (APL-2671): a subtask ticked done BEFORE its parent entered the done section stays done when the done flag moves back", async ({ admin, later }) => {
  // AC4 as reworded (NJ decision 18 Oct 2026, APL-2671): only subtasks completed together with the parent reopen with it;
  // a subtask ticked done on its own before the parent was completed stays done, with its own completedAt.
  const t = await tree(admin, later, "bug3 preticked");
  expect((await finish(admin, t.subs[0])).status).toBe(200); // ticked on its own, parent still open
  expect(await states(admin, t.all)).toEqual([false, true, false]);
  const ticked = (await getTask(admin, t.subs[0])).completedAt;
  const on = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  if (on.status !== 200) {
    expect(await states(admin, t.all), "a refusal leaves the pre-ticked subtask done and the others open").toEqual([false, true, false]);
    return;
  }
  expect(await states(admin, t.all), "all three are complete after the change").toEqual([true, true, true]);
  const back = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { isDone: true });
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect(await states(admin, t.all), "parent and the cascaded subtask reopen; the pre-ticked subtask stays done").toEqual([false, true, false]);
  expect((await getTask(admin, t.subs[0])).completedAt, "the pre-ticked subtask keeps its own completedAt").toBe(ticked);
});

test("AC5: a subtask with a due date that closed with its parent gets no reminder notification", async ({ admin, later }) => {
  // The reminder job (src/lib/jobs.ts sendReminders, 8:00 am India time) needs a job secret a browser session does not have, so it is not
  // triggered here. The test checks what the job reads (the subtask is complete) and that no reminder for this run's ZZ-TEST subtasks exists.
  const t = await tree(admin, later, "bug3 no reminder");
  const r = await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true });
  expect(await expectRefusedOrCascaded(admin, t, r.status, r.json), "on a build with PR #6 the done flag cascades").toBe("cascade");
  for (const s of t.subs) {
    const sub = await getTask(admin, s);
    expect(sub.completedAt, "closed with its parent, so sendReminders (completedAt: null) skips it").toBeTruthy();
    expect(sub.dueDate, "control: the subtask still has its due date").toBe(ymd(1));
  }
  const items = (await admin.api.get("/api/notifications?limit=200")).json.items as Record<string, unknown>[];
  const reminders = items.map((n) => JSON.stringify(n)).filter((n) => n.includes("ZZ-TEST") && /is due tomorrow|is due today|is overdue/.test(n));
  for (const title of t.titles.slice(1)) expect(reminders.filter((n) => n.includes(title)), `no reminder for "${title}"`).toEqual([]);
});

test("APL-2678: moving the done flag leaves a parent task in Trash untouched", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "bug3 trash" });
  // Two completed parents in the done section: one moved to Trash, one left live as the control that does reopen.
  const trashed = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz("bug3 trashed parent") });
  const live = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz("bug3 live parent") });
  for (const id of [trashed, live]) expect((await finish(admin, id)).status).toBe(200);
  const before = await getTask(admin, trashed);
  expect(before.completedAt, "the parent is complete before it goes to Trash").toBeTruthy();
  expect(before.sectionId).toBe(p.done);
  expect((await admin.api.del(`/api/tasks/${trashed}`)).status).toBe(204);

  const r = await admin.api.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((await getTask(admin, live)).completedAt, "control: the live parent in the old done section reopened").toBeNull();
  expect((await admin.api.get(`/api/tasks/${trashed}`)).status, "still in Trash").toBe(404);

  // A task in Trash cannot be read, and restoring changes only deletedAt (and a gone assignee), so read it back through a restore.
  expect((await admin.api.post(`/api/tasks/${trashed}/restore`)).status).toBe(200);
  const after = await getTask(admin, trashed);
  expect(after.completedAt, "completedAt unchanged by the flag move").toBe(before.completedAt);
  expect(after.sectionId, "still in the section it was trashed from").toBe(before.sectionId);
});

// APL-2671 (AC4 reworded): through the task's own Complete and Reopen, which the done-flag tests above do not use.
/** A parent with two open subtasks held by the Super Admin. */
async function family(admin: Who, later: Later, label: string) {
  const p = await newProject(admin, later, { label });
  const parent = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz(`${label} parent`) });
  const a = await newTask(admin, p.id, { title: zz(`${label} sub A`), parentId: parent, assigneeId: admin.user.id });
  const b = await newTask(admin, p.id, { title: zz(`${label} sub B`), parentId: parent, assigneeId: admin.user.id });
  return { parent, a, b };
}

test("APL-2671 AC2: a subtask ticked done on its own before the parent was completed stays done when the parent is reopened", async ({ admin, later }) => {
  const f = await family(admin, later, "2671 ac2");
  // Both subtasks ticked on their own, so nothing cascades when the parent completes.
  for (const s of [f.a, f.b]) expect((await finish(admin, s)).status).toBe(200);
  const ticked = await Promise.all([f.a, f.b].map(async (s) => (await getTask(admin, s)).completedAt));
  expect((await admin.api.post(`/api/tasks/${f.parent}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${f.parent}`)).json.task.updatedAt })).status).toBe(200);
  expect(await states(admin, [f.parent, f.a, f.b])).toEqual([true, true, true]);
  expect((await admin.api.post(`/api/tasks/${f.parent}/reopen`, {})).status).toBe(200);
  expect(await states(admin, [f.parent, f.a, f.b]), "the parent reopens; both subtasks ticked on their own stay done").toEqual([false, true, true]);
  for (const [i, s] of [f.a, f.b].entries()) expect((await getTask(admin, s)).completedAt, "keeps its own completedAt").toBe(ticked[i]);
});

test("APL-2671 AC3: with A ticked alone and B cascaded under one parent, reopening the parent reopens only B", async ({ admin, later }) => {
  const f = await family(admin, later, "2671 ac3");
  expect((await finish(admin, f.a)).status).toBe(200); // A ticked alone; B left open
  const tickedA = (await getTask(admin, f.a)).completedAt;
  expect((await finish(admin, f.parent, { completeAll: true })).status).toBe(200); // B cascades
  expect(await states(admin, [f.parent, f.a, f.b]), "parent, A and B are all done").toEqual([true, true, true]);
  expect((await admin.api.post(`/api/tasks/${f.parent}/reopen`, {})).status).toBe(200);
  expect(await states(admin, [f.parent, f.a, f.b]), "the parent and B reopen; A stays done").toEqual([false, true, false]);
  expect((await getTask(admin, f.a)).completedAt, "A keeps its own completedAt").toBe(tickedA);
  expect((await getTask(admin, f.parent)).subtasks, "the parent shows one open subtask of two").toEqual({ total: 2, open: 1 });
});

test("AC4: the done-flag move back reopens subtasks closed with the parent and does not clear a trashed parent", async ({ admin, later }) => {
  const t = await tree(admin, later, "done flag trash");
  const trashed = await newTask(admin, t.p.id, { dueDate: "2026-11-03", title: zz("closed in trash"), sectionId: t.p.doing });
  expect((await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.doing}`, { isDone: true })).status).toBe(200);
  expect(await states(admin, t.all)).toEqual([true, true, true]);
  const closedAt = (await getTask(admin, trashed)).completedAt;
  expect(closedAt).not.toBeNull();
  expect((await admin.api.del(`/api/tasks/${trashed}`)).status).toBe(204);
  expect((await admin.api.patch(`/api/projects/${t.p.id}/sections/${t.p.done}`, { isDone: true })).status).toBe(200);
  expect(await states(admin, t.all)).toEqual([false, false, false]);
  expect((await admin.api.post(`/api/tasks/${trashed}/restore`)).status).toBe(200);
  expect((await getTask(admin, trashed)).completedAt).toBe(closedAt);
});
