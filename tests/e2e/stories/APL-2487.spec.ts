// SHO-US-3.3 Project roles Leader, Editor and Viewer (Linear APL-2487).
// The Super Admin acts as the Leader; the plain Member (SHO_MEMBER_*) is given the Editor or Viewer role. Member tests skip without it.
import { test, expect, zz } from "../support";
import { ghost, getTask, newProject, newTask } from "../g2";

test("AC1: an Editor creates, edits, assigns and deletes a task", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 editor", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(member, p.id, { dueDate: "2026-11-03" });
  expect((await member.api.patch(`/api/tasks/${t}`, { title: zz("3.3 renamed"), expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(200);
  expect((await member.api.post(`/api/tasks/${t}/assign`, { assigneeId: admin.user.id, expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(200);
  expect((await getTask(member, t)).assignee.id).toBe(admin.user.id);
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
});

test("AC1: an Editor cannot change members, roles, Sections or project details, or restore from Trash", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 editor limits", members: [{ who: member, role: "EDITOR" }] });
  const other = await ghost(admin, later);
  expect((await member.api.post(`/api/projects/${p.id}/members`, { userId: other.id })).status).toBe(403);
  expect((await member.api.patch(`/api/projects/${p.id}/members/${admin.user.id}`, { role: "EDITOR" })).status).toBe(403);
  expect((await member.api.post(`/api/projects/${p.id}/sections`, { name: zz("3.3 section") })).status).toBe(403);
  expect((await member.api.patch(`/api/projects/${p.id}`, { name: zz("3.3 renamed project") })).status).toBe(403);
  const t = await newTask(member, p.id, { dueDate: "2026-11-03" });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await member.api.post(`/api/tasks/${t}/restore`)).status).toBe(403);
  expect((await admin.api.post(`/api/tasks/${t}/restore`)).status).toBe(200); // the Leader (here the Super Admin) may
});

test("AC2: a Viewer's writes are refused by the API", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 viewer", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
  const other = await ghost(admin, later);
  expect((await member.api.post(`/api/projects/${p.id}/tasks`, { dueDate: "2026-11-03", title: zz("v") })).status).toBe(403);
  expect((await member.api.patch(`/api/tasks/${t}`, { title: zz("v") })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/assign`, { assigneeId: admin.user.id })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(403);
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(403);
  expect((await member.api.post(`/api/projects/${p.id}/members`, { userId: other.id })).status).toBe(403);
  expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(200); // reading is allowed
});

test("AC3: a project has exactly one Leader, and the Leader cannot be removed or demoted from the members panel", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 one leader", members: [{ who: member }] });
  const members = (await admin.api.get(`/api/projects/${p.id}`)).json.project.members as { userId: string; role: string }[];
  expect(members.filter((m) => m.role === "LEADER")).toHaveLength(1);
  expect((await admin.api.del(`/api/projects/${p.id}/members/${admin.user.id}`)).status).toBe(409);
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${admin.user.id}`, { role: "VIEWER" })).status).toBe(409);
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${admin.user.id}`, { role: "EDITOR" })).status).toBe(409);
  const after = (await admin.api.get(`/api/projects/${p.id}`)).json.project.members as { role: string }[];
  expect(after.filter((m) => m.role === "LEADER")).toHaveLength(1);
});

test("AC4: a task cannot be assigned to a Viewer, a non-member or a deactivated person", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 assign", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
  const outsider = await ghost(admin, later, "outsider");
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: member.user.id })).status).toBe(400); // Viewer
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: outsider.id })).status).toBe(400); // not a member
  expect((await admin.api.post(`/api/projects/${p.id}/tasks`, { dueDate: "2026-11-03", title: zz("v"), assigneeId: member.user.id })).status).toBe(400);
  await admin.api.post(`/api/team/${outsider.id}/deactivate`, { reassign: "leaders" });
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: outsider.id })).status).toBe(400); // deactivated
});

test("AC5: demoting a member with open tasks to Viewer needs a taker, and no task is left unassigned", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.3 demote", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(member, p.id, { dueDate: "2026-11-03" });
  const refused = await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER" });
  expect(refused.status).toBe(409);
  expect((await getTask(admin, t)).assignee.id).toBe(member.user.id); // still theirs, nothing half done
  const ok = await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER", handoverTo: admin.user.id });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id);
});
