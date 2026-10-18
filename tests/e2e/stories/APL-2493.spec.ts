// SHO-US-4.3 Assign a task and add collaborators (Linear APL-2493).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the assignee / collaborator / Viewer. Member tests skip without it.
import { test, expect, zz, type Api } from "../support";
import { ghost, getTask, newProject, newTask } from "../g2";

const mentions = async (who: { api: Api }, text: string) =>
  ((await who.api.get("/api/notifications")).json.items as { text: string }[]).filter((n) => n.text.includes(text)).length;
const inMyTasks = async (who: { api: Api }, id: string) => JSON.stringify((await who.api.get("/api/my-tasks")).json).includes(id);

test("AC1: an assignee sees the task in My tasks and is notified; so is an added collaborator", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac1", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("4.3 assigned");
  const t = await newTask(admin, p.id, { title });
  expect(await inMyTasks(member, t)).toBe(false);
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: member.user.id })).status).toBe(200);
  expect(await inMyTasks(member, t)).toBe(true);
  expect(await mentions(member, title), "an assignment notice naming the task").toBeGreaterThan(0);

  const title2 = zz("4.3 collab");
  const c = await newTask(admin, p.id, { title: title2 }); // stays with the Super Admin
  expect((await admin.api.post(`/api/tasks/${c}/collaborators`, { userId: member.user.id })).status).toBe(201);
  expect(await inMyTasks(member, c)).toBe(true);
  expect(await mentions(member, title2), "a collaborator notice naming the task").toBeGreaterThan(0);
});

test("AC2: a Viewer, a non-member or a deactivated person cannot be the assignee, and the assignee cannot be cleared", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac2", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id);
  const outsider = await ghost(admin, later, "outsider");
  const gone = await ghost(admin, later, "gone");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: gone.id });
  await admin.api.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" });
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: member.user.id })).status).toBe(400);
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: outsider.id })).status).toBe(400);
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: gone.id })).status).toBe(400);
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: "" })).status).toBe(400);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id);
});

test("AC3: only active project members can be collaborators; a Viewer may be", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac3" });
  const t = await newTask(admin, p.id);
  const viewer = await ghost(admin, later, "viewer");
  const outsider = await ghost(admin, later, "outsider");
  const gone = await ghost(admin, later, "gone");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: gone.id });
  await admin.api.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" });
  expect((await admin.api.post(`/api/tasks/${t}/collaborators`, { userId: viewer.id })).status).toBe(201);
  expect((await admin.api.post(`/api/tasks/${t}/collaborators`, { userId: outsider.id })).status).toBe(400);
  expect((await admin.api.post(`/api/tasks/${t}/collaborators`, { userId: gone.id })).status).toBe(400);
  const ids = ((await getTask(admin, t)).collaborators as { id: string }[]).map((c) => c.id);
  expect(ids).toEqual([viewer.id]);
});

test("AC4: a Viewer cannot assign or add collaborators", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac4", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id);
  expect((await member.api.post(`/api/tasks/${t}/assign`, { assigneeId: admin.user.id })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/collaborators`, { userId: member.user.id })).status).toBe(403);
});

test("AC5: a collaborator removed from the project is dropped from its tasks, with one removal notice, not one per task", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac5", members: [{ who: member, role: "EDITOR" }] });
  const t1 = await newTask(admin, p.id, { title: zz("4.3 drop one") });
  const t2 = await newTask(admin, p.id, { title: zz("4.3 drop two") });
  for (const t of [t1, t2]) expect((await admin.api.post(`/api/tasks/${t}/collaborators`, { userId: member.user.id })).status).toBe(201);
  expect((await admin.api.del(`/api/projects/${p.id}/members/${member.user.id}`)).status).toBe(204); // no taker needed: they hold no task
  for (const t of [t1, t2]) expect(((await getTask(admin, t)).collaborators as unknown[]).length).toBe(0);
  const items = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  const removal = items.filter((n) => n.text.includes(p.name) && /removed you/i.test(n.text));
  expect(removal, "one removal notice for the project").toHaveLength(1);
  expect(items.filter((n) => /taken off|no longer a collaborator/i.test(n.text) && n.text.includes("drop")), "no separate notice per task").toHaveLength(0);
  // The drop is reported inside the removal notice. (The live wording gives a count, "taken off 2 tasks as a collaborator", not the task names.)
  expect(removal[0].text).toMatch(/taken off 2 tasks as a collaborator/);
});

test("AC6: with no approver, the assignee, any Editor and the Leader may complete; a Viewer collaborator may not", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.3 ac6", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(admin, p.id); // assigned to the Super Admin, no approver
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(200); // another Editor
  expect((await getTask(admin, t)).completedAt).not.toBeNull();
  const own = await newTask(member, p.id);
  expect((await member.api.post(`/api/tasks/${own}/complete`)).status).toBe(200); // the assignee
  const led = await newTask(member, p.id);
  expect((await admin.api.post(`/api/tasks/${led}/complete`)).status).toBe(200); // the Leader

  const v = await newProject(admin, later, { label: "4.3 ac6 viewer", members: [{ who: member, role: "VIEWER" }] });
  const vt = await newTask(admin, v.id);
  expect((await admin.api.post(`/api/tasks/${vt}/collaborators`, { userId: member.user.id })).status).toBe(201);
  expect((await member.api.post(`/api/tasks/${vt}/complete`)).status).toBe(403);
});
