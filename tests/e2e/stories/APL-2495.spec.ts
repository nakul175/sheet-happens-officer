// SHO-US-4.5 Complete and reopen a task (Linear APL-2495).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the Editor/Viewer/assignee. Member tests skip without it.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask } from "../g2";

test("AC1: completing sets completedAt, moves the task to the Done Section, and it shows as done (tick on the list)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 tick" });
  const title = zz("4.5 tick me");
  const t = await newTask(admin, p.id, { title });
  await admin.page.goto(`/projects/${p.id}`);
  await admin.page.getByRole("button", { name: `Complete "${title}"` }).click();
  await expect.poll(async () => (await getTask(admin, t)).completedAt).not.toBeNull();
  const got = await getTask(admin, t);
  expect(got.sectionId).toBe(p.done);
  await expect(admin.page.getByRole("button", { name: `Reopen "${title}"` })).toBeVisible();
});

test("AC1: moving a task into the Done Section completes it", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 drag" });
  const t = await newTask(admin, p.id);
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.completedAt).not.toBeNull();
  expect(got.sectionId).toBe(p.done);
});

test("AC2: reopening clears completedAt and returns the task to the Section it came from, or to the one it is dragged to", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 reopen" });
  const t = await newTask(admin, p.id, { sectionId: p.doing });
  await admin.api.post(`/api/tasks/${t}/complete`);
  expect((await admin.api.post(`/api/tasks/${t}/reopen`)).status).toBe(200);
  let got = await getTask(admin, t);
  expect(got.completedAt).toBeNull();
  expect(got.sectionId).toBe(p.doing); // where it was before completion
  await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.done });
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.todo })).status).toBe(200); // dragged out to another Section
  got = await getTask(admin, t);
  expect(got.completedAt).toBeNull();
  expect(got.sectionId).toBe(p.todo);
});

test("AC3: completing a task with open subtasks warns; 'Complete all' closes them with one log row each; no silent completion", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 subtasks" });
  const parent = await newTask(admin, p.id, { sectionId: p.doing });
  const subs = [await newTask(admin, p.id, { parentId: parent }), await newTask(admin, p.id, { parentId: parent })];
  const warn = await admin.api.post(`/api/tasks/${parent}/complete`);
  expect(warn.status).toBe(409);
  expect(warn.json.needsConfirm).toBe("open_subtasks");
  expect((await getTask(admin, parent)).completedAt).toBeNull();
  for (const s of subs) expect((await getTask(admin, s)).completedAt).toBeNull(); // nothing completed silently
  expect((await admin.api.post(`/api/tasks/${parent}/complete`, { completeAll: true })).status).toBe(200);
  for (const s of [parent, ...subs]) expect((await getTask(admin, s)).completedAt).not.toBeNull();
  const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { what: string }[];
  expect(items.filter((i) => /completed/.test(i.what)).length).toBe(3); // one for the parent, one for each subtask
});

test("AC3: the tick on a task with open subtasks asks 'Complete them all' or Cancel (screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 ask" });
  const title = zz("4.5 parent");
  const parent = await newTask(admin, p.id, { title });
  await newTask(admin, p.id, { parentId: parent });
  await admin.page.goto(`/projects/${p.id}`);
  await admin.page.getByRole("button", { name: `Complete "${title}"` }).click();
  const dlg = admin.page.getByRole("dialog");
  await expect(dlg).toContainText("1 open subtask");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect((await getTask(admin, parent)).completedAt).toBeNull();
});

test("AC4: a Viewer, or an archived project, cannot complete or reopen", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.5 viewer", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id);
  const done = await newTask(admin, p.id);
  await admin.api.post(`/api/tasks/${done}/complete`);
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${done}/reopen`)).status).toBe(403);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await admin.api.post(`/api/tasks/${t}/complete`)).status).toBe(409);
  expect((await admin.api.post(`/api/tasks/${done}/reopen`)).status).toBe(409);
});

test("AC4: with an approver, a person who may not close it gets no usable tick and is refused moving it to Done", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.5 approver", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("4.5 needs approval");
  const t = await newTask(admin, p.id, { title, assigneeId: member.user.id, approverId: admin.user.id });
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(403);
  await member.page.goto(`/projects/${p.id}`);
  const tick = member.page.getByRole("button", { name: `"${title}" can only be closed by its approver` });
  await expect(tick).toBeVisible();
  await expect(tick).toBeDisabled();
  expect((await getTask(admin, t)).completedAt).toBeNull();
});
