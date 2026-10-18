// SHO-US-3.6 Archive a project (Linear APL-2490).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the Editor/Viewer/assignee. Member tests skip without it.
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";

const listed = async (who: { api: any }, id: string, archived = false) =>
  ((await who.api.get(`/api/projects${archived ? "?archived=true" : ""}`)).json.projects as { id: string }[]).some((p) => p.id === id);

test("AC1: archiving removes the project from active lists and refuses new or changed tasks", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "3.6 ac1" });
  const t = await newTask(admin, p.id);
  expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
  expect(await listed(admin, p.id)).toBe(false);
  expect(await listed(admin, p.id, true)).toBe(true);
  expect((await admin.api.post(`/api/projects/${p.id}/tasks`, { title: zz("x") })).status).toBe(409);
  expect((await admin.api.patch(`/api/tasks/${t}`, { title: zz("x") })).status).toBe(409);
  expect((await admin.api.post(`/api/tasks/${t}/complete`)).status).toBe(409);
});

test("AC2: unarchiving returns the project unchanged and its open tasks to My tasks", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.6 ac2", members: [{ who: member }] });
  const t = await newTask(admin, p.id, { assigneeId: member.user.id });
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect(JSON.stringify((await member.api.get("/api/my-tasks")).json)).not.toContain(t);
  expect((await admin.api.post(`/api/projects/${p.id}/unarchive`)).status).toBe(200);
  expect(await listed(admin, p.id)).toBe(true);
  expect(JSON.stringify((await member.api.get("/api/my-tasks")).json)).toContain(t);
  expect((await admin.api.patch(`/api/tasks/${t}`, { title: zz("3.6 editable again") })).status).toBe(200);
});

test("AC3: an Editor or a Viewer cannot archive or unarchive", async ({ admin, member, later }) => {
  for (const role of ["EDITOR", "VIEWER"] as const) {
    const p = await newProject(admin, later, { label: `3.6 ${role}`, members: [{ who: member, role }] });
    expect((await member.api.post(`/api/projects/${p.id}/archive`)).status).toBe(403);
    await admin.api.post(`/api/projects/${p.id}/archive`);
    expect((await member.api.post(`/api/projects/${p.id}/unarchive`)).status).toBe(403);
  }
});

test("AC4: members can still open and read an archived project; nobody can change it", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.6 readonly", members: [{ who: member }] });
  const t = await newTask(admin, p.id);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await member.api.get(`/api/projects/${p.id}`)).status).toBe(200);
  expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(200);
  expect((await member.api.patch(`/api/tasks/${t}`, { title: zz("x") })).status).toBe(409);
  expect((await admin.api.patch(`/api/tasks/${t}`, { title: zz("x") })).status).toBe(409);
  await member.page.goto(`/projects/${p.id}`);
  await expect(member.page.getByText("This project is archived and read-only.").first()).toBeVisible();
});

test("AC5: the confirmation states how many tasks are still open, and assignees are notified on confirming", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.6 warning", members: [{ who: member }] });
  await newTask(admin, p.id);
  await newTask(member, p.id);
  await admin.page.goto(`/projects/${p.id}/members`);
  await admin.page.getByRole("button", { name: "Archive…" }).click();
  const dlg = admin.page.getByRole("dialog");
  await expect(dlg).toContainText("2 open tasks");
  await dlg.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(admin.page.getByText("This project is archived and read-only.").first()).toBeVisible();
  const notes = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(notes.some((n) => n.text.includes(p.name)), "an archive notice naming the project").toBe(true);
});

test("AC6: archived tasks are missing from My tasks and default search; 'Include archived' shows them to members only", async ({ admin, member, later }) => {
  const word = `zzarch${Date.now().toString(36)}`;
  const p = await newProject(admin, later, { label: "3.6 hidden", members: [{ who: member }] });
  const t = await newTask(admin, p.id, { title: `${word} task`, assigneeId: member.user.id });
  expect(JSON.stringify((await member.api.get("/api/my-tasks")).json)).toContain(t);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect(JSON.stringify((await member.api.get("/api/my-tasks")).json)).not.toContain(t);
  const found = async (extra = "") => ((await member.api.get(`/api/search?q=${word}${extra}`)).json.tasks as unknown[]).length;
  expect(await found()).toBe(0);
  expect(await found("&archived=true")).toBe(1);
});
