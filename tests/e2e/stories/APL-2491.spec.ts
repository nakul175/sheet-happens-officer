// SHO-US-4.1 Create tasks and subtasks (Linear APL-2491).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the Editor/Viewer. Member tests skip without it.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask, ymd } from "../g2";

test("AC1: an Editor's new task sits in the Section it was added from, assigned to them, in due-date order (undated last)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.1 ac1", members: [{ who: member, role: "EDITOR" }] });
  const late = await newTask(member, p.id, { title: zz("late"), dueDate: ymd(20) });
  const none = await newTask(member, p.id, { title: zz("none") });
  const soon = await newTask(member, p.id, { title: zz("soon"), dueDate: ymd(2) });
  const doing = await newTask(member, p.id, { title: zz("doing"), sectionId: p.doing });
  const t = await getTask(member, soon);
  expect(t.assignee.id).toBe(member.user.id);
  expect(t.sectionId).toBe(p.todo); // the first non-Done Section when none is given
  expect((await getTask(member, doing)).sectionId).toBe(p.doing);
  const list = (await member.api.get(`/api/projects/${p.id}/tasks`)).json.sections[0];
  expect(list.tasks.map((x: { id: string }) => x.id)).toEqual([soon, late, none]);
});

test("AC1: adding straight to the Done Section is refused", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.1 done" });
  const r = await admin.api.post(`/api/projects/${p.id}/tasks`, { title: zz("x"), sectionId: p.done });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
});

test("AC1: typing a title in a Section's quick add creates the task there (screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.1 screen" });
  const title = zz("4.1 typed");
  await admin.page.goto(`/projects/${p.id}`);
  const box = admin.page.getByLabel("Add a task").first();
  await box.fill(title);
  await box.press("Enter");
  await expect(admin.page.getByText(title).first()).toBeVisible();
  const list = (await admin.api.get(`/api/projects/${p.id}/tasks`)).json.sections[0];
  expect(list.tasks.some((x: { title: string }) => x.title === title)).toBe(true);
});

test("AC2: a subtask belongs to its task and is assigned to the person who added it; no subtask of a subtask", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.1 sub", members: [{ who: member }] });
  const parent = await newTask(admin, p.id);
  const sub = await newTask(member, p.id, { parentId: parent, title: zz("sub") });
  const s = await getTask(member, sub);
  expect(s.parentId).toBe(parent);
  expect(s.assignee.id).toBe(member.user.id);
  const deep = await member.api.post(`/api/projects/${p.id}/tasks`, { title: zz("deep"), parentId: sub });
  expect(deep.status).toBe(400);
});

test("AC3: a Viewer cannot create tasks, and nobody can in an archived project", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.1 viewer", members: [{ who: member, role: "VIEWER" }] });
  expect((await member.api.post(`/api/projects/${p.id}/tasks`, { title: zz("v") })).status).toBe(403);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await admin.api.post(`/api/projects/${p.id}/tasks`, { title: zz("a") })).status).toBe(409);
});

test("AC4: a task always has an assignee: it cannot be saved or reassigned to nobody", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.1 assignee" });
  const t = await newTask(admin, p.id);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id); // defaults to the creator
  for (const bad of [null, "", undefined]) {
    const r = await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: bad });
    expect(r.status).toBe(400);
  }
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id);
  const empty = await admin.api.post(`/api/projects/${p.id}/tasks`, { title: zz("x"), assigneeId: "" });
  expect(empty.status).toBe(400);
});
