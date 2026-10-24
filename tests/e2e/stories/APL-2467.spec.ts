// APL-2467 · [SHO-E3] Projects and membership. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
import { test, login } from "../support";
import {
  PASS, passwordOk, gate, verifiedUser, deactivate, makeProject, archiveProject, expect, zz,
} from "./qa";

test.beforeAll(async ({ request }) => {
  if (!PASS) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

test("AC1: any member can create a project and name its Leader", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2467", "ac1");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  const name = zz("led");
  const created = await member.api.post("/api/projects", { name, leaderId: admin.user.id });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id as string));
  const loaded = await admin.api.get(`/api/projects/${id}`);
  const members = loaded.json.project.members as { userId: string; role: string }[];
  expect(members.find((m) => m.userId === admin.user.id)?.role).toBe("LEADER");
  expect(members.find((m) => m.userId === member.user.id)?.role).toBe("EDITOR");
});

test("AC2: a Member who is not on a project cannot see it in lists, search, or by a direct link", async ({ admin, browser, anon, later }) => {
  const outsider = await verifiedUser(browser, anon.request, "2467", "ac2");
  later(() => outsider.ctx.close());
  later(() => deactivate(admin.api, outsider.user.id as string));
  const project = await makeProject(admin.api, "hidden", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const task = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("secret") });
  expect(task.status).toBe(201);
  const taskId = task.json.task.id as string;

  const listed = (await outsider.api.get("/api/projects")).json.projects as { id: string }[];
  expect(listed.some((p) => p.id === project.id)).toBe(false);
  const found = await outsider.api.get(`/api/search?q=${encodeURIComponent(project.name.slice(0, 24))}`);
  expect(found.status).toBe(200);
  expect((found.json.projects as { id: string }[]).some((p) => p.id === project.id)).toBe(false);
  expect((found.json.tasks as { id: string }[]).some((t) => t.id === taskId)).toBe(false);
  expect((await outsider.api.get(`/api/projects/${project.id}`)).json.error).toBe("Project not found");
  expect((await outsider.api.get(`/api/projects/${project.id}/tasks`)).status).toBe(404);
  const hiddenTask = await outsider.api.get(`/api/tasks/${taskId}`);
  expect(hiddenTask.status).toBe(404);
  expect(hiddenTask.json.error).toBe("Task not found");
  expect(JSON.stringify(hiddenTask.json)).not.toContain(zz("secret"));
  await outsider.page.goto(`/projects/${project.id}`);
  await expect(outsider.page.getByText("This project isn't available")).toBeVisible();
});

test("AC3: an Admin or Super Admin sees every project", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2467", "ac3");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  const created = await member.api.post("/api/projects", { name: zz("private"), leaderId: member.user.id });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id as string));

  const all = (await admin.api.get("/api/projects")).json.projects as { id: string; myRole: string | null }[];
  const row = all.find((p) => p.id === id);
  expect(row, "Super Admin list includes a project they were not added to").toBeTruthy();
  expect(row!.myRole).toBeNull();
  await admin.page.goto("/projects");
  await admin.page.getByRole("button", { name: "All projects" }).click();
  await expect(admin.page.getByText(zz("private"))).toBeVisible();
});

test("AC4: a Leader manages members and tasks, an Editor edits tasks, and a Viewer can only read", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2467", "ac4-ed");
  const viewer = await verifiedUser(browser, anon.request, "2467", "ac4-view");
  later(() => editor.ctx.close());
  later(() => viewer.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  later(() => deactivate(admin.api, viewer.user.id as string));
  const project = await makeProject(admin.api, "roles", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: viewer.user.id, role: "VIEWER" })).status).toBe(201);
  const task = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("editable") });
  expect(task.status, JSON.stringify(task.json)).toBe(201);
  const taskId = task.json.task.id as string;

  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(409);
  const renamed = await editor.api.patch(`/api/tasks/${taskId}`, { title: zz("edited"), expectedUpdatedAt: (await editor.api.get(`/api/tasks/${taskId}`)).json.task.updatedAt });
  expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
  const viewerWrite = await viewer.api.patch(`/api/tasks/${taskId}`, { title: zz("nope") });
  expect(viewerWrite.status).toBe(403);
  expect(viewerWrite.json.error).toBe("Viewers cannot make changes.");
  expect((await viewer.api.get(`/api/tasks/${taskId}`)).status).toBe(200);
  const viewerMember = await viewer.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "VIEWER" });
  expect(viewerMember.status).toBe(403);
  expect(viewerMember.json.error).toBe("Only the project Leader or an Admin can do this.");
});

test("AC5: a Leader searches active people, adds a member, and removing them hands over their open tasks", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2467", "ac5");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "members", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));

  await admin.page.goto(`/projects/${project.id}/members`);
  await admin.page.getByLabel("Search by name or email").fill(editor.email);
  const hit = admin.page.locator(".item", { hasText: editor.name });
  await expect(hit).toBeVisible();
  await hit.getByRole("button", { name: "Add" }).click();
  await expect.poll(async () => {
    const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
    return members.some((m) => m.userId === editor.user.id);
  }).toBe(true);

  const task = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("owned"), assigneeId: editor.user.id });
  expect(task.status).toBe(201);
  const taskId = task.json.task.id as string;
  await admin.page.reload();
  await admin.page.locator(".item", { hasText: editor.name }).getByRole("button", { name: "Remove" }).click();
  const dialog = admin.page.getByRole("dialog");
  await expect(dialog).toContainText(`Remove ${editor.name}?`);
  await dialog.getByLabel("Who takes their tasks?").selectOption(admin.user.id as string);
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.assignee.id).toBe(admin.user.id);
  const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(members.some((m) => m.userId === editor.user.id)).toBe(false);
});

test("AC6: a Leader can hand leadership to another member", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2467", "ac6");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "leader", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);

  await admin.page.goto(`/projects/${project.id}/members`);
  await admin.page.getByRole("button", { name: "Change leader…" }).click();
  const dialog = admin.page.getByRole("dialog");
  await dialog.getByLabel("New leader").selectOption(editor.user.id as string);
  await dialog.getByRole("button", { name: "Change leader", exact: true }).click();
  await expect.poll(async () => {
    const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string; role: string }[];
    return members.find((m) => m.userId === editor.user.id)?.role;
  }).toBe("LEADER");
});

test("AC7: an archived project stays visible to its members and is read-only", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2467", "ac7");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "archived", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/archive`)).status).toBe(200);

  const loaded = await editor.api.get(`/api/projects/${project.id}`);
  expect(loaded.status).toBe(200);
  expect(loaded.json.project.archived).toBe(true);
  const write = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("too late") });
  expect(write.status).toBe(409);
  expect(write.json.error).toBe("This project is archived and read-only.");
  await editor.page.goto(`/projects/${project.id}`);
  await expect(editor.page.getByText("This project is archived and read-only.")).toBeVisible();
});
