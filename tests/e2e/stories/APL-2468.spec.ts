// APL-2468 · [SHO-E4] Tasks. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
import { test, login } from "../support";
import {
  PASS, passwordOk, gate, verifiedUser, deactivate, makeProject, archiveProject, expect, zz,
} from "./qa";

test.beforeAll(async ({ request }) => {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  await gate(request);
});

const calm = async (page: import("@playwright/test").Page) => {
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  if (await fold.count()) await fold.first().click();
};

test("AC1: a Leader or Editor can create a task and one subtask, and a subtask of a subtask is refused", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2468", "ac1");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "tasks", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);

  const parent = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("parent") });
  expect(parent.status, JSON.stringify(parent.json)).toBe(201);
  const parentId = parent.json.task.id as string;
  const child = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("child"), parentId });
  expect(child.status, JSON.stringify(child.json)).toBe(201);
  const childId = child.json.task.id as string;
  expect((await editor.api.get(`/api/tasks/${parentId}`)).json.task.subtasks.total).toBe(1);
  expect((await editor.api.get(`/api/tasks/${childId}`)).json.task.parentId).toBe(parentId);

  const nested = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("nested"), parentId: childId });
  expect(nested.status).toBe(400);
  expect(nested.json.error).toBe("A subtask cannot have subtasks.");
});

test("AC2: title, description, assignee, collaborators, due date and priority are saved and shown", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2468", "ac2-ed");
  const mate = await verifiedUser(browser, anon.request, "2468", "ac2-mate");
  later(() => editor.ctx.close());
  later(() => mate.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  later(() => deactivate(admin.api, mate.user.id as string));
  const project = await makeProject(admin.api, "details", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: mate.user.id, role: "EDITOR" })).status).toBe(201);
  const created = await editor.api.post(`/api/projects/${project.id}/tasks`, { title: zz("draft") });
  const id = created.json.task.id as string;
  const title = zz("saved");
  const description = zz("notes");
  const saved = await editor.api.patch(`/api/tasks/${id}`, { title, description, dueDate: "2026-11-02", priority: "HIGH" });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect((await editor.api.post(`/api/tasks/${id}/assign`, { assigneeId: mate.user.id })).status).toBe(200);
  expect((await editor.api.post(`/api/tasks/${id}/collaborators`, { userId: editor.user.id })).status).toBe(201);

  const task = (await editor.api.get(`/api/tasks/${id}`)).json.task;
  expect(task).toMatchObject({ title, description, dueDate: "2026-11-02", priority: "HIGH" });
  expect(task.assignee.id).toBe(mate.user.id);
  expect((task.collaborators as { id: string }[]).map((c) => c.id)).toContain(editor.user.id);

  await editor.page.goto(`/projects/${project.id}?task=${id}`);
  const dialog = editor.page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByLabel("Title")).toHaveValue(title);
  await expect(dialog.getByLabel("Description")).toHaveValue(description);
  await expect(dialog.getByLabel("Priority")).toHaveValue("HIGH");
  await expect(dialog.getByLabel("Due date")).toHaveValue("2026-11-02");
  await expect(dialog.getByLabel("Assignee")).toHaveValue(mate.user.id as string);
  await expect(dialog.locator(".chip", { hasText: editor.name })).toBeVisible();
});

test("AC3: setting or clearing Blocked shows on the task in every view", async ({ admin, browser, anon, later }) => {
  const editor = await verifiedUser(browser, anon.request, "2468", "ac3");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "blocked", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("flagged");
  const created = await editor.api.post(`/api/projects/${project.id}/tasks`, { title, assigneeId: editor.user.id });
  const id = created.json.task.id as string;
  expect((await editor.api.patch(`/api/tasks/${id}`, { blocked: true, blockedReason: "Waiting on a file" })).status).toBe(200);

  const inList = async () => {
    const sections = (await editor.api.get(`/api/projects/${project.id}/tasks`)).json.sections as { tasks: { id: string; blocked: boolean }[] }[];
    return sections.flatMap((s) => s.tasks).find((t) => t.id === id)?.blocked;
  };
  expect(await inList()).toBe(true);
  const mine = (await editor.api.get("/api/my-tasks")).json;
  const groups = ["waitingOnMe", "waitingOnOthers", "overdue", "next7", "later"] as const;
  const row = groups.flatMap((g) => (mine[g] ?? []) as { id: string; blocked: boolean }[]).find((t) => t.id === id);
  expect(row?.blocked).toBe(true);

  await editor.page.goto(`/projects/${project.id}`);
  await calm(editor.page);
  await expect(editor.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();
  await editor.page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(editor.page.locator(".bcard", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();
  await editor.page.goto("/");
  await expect(editor.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();

  expect((await editor.api.patch(`/api/tasks/${id}`, { blocked: false })).status).toBe(200);
  expect(await inList()).toBe(false);
  await editor.page.goto(`/projects/${project.id}`);
  await expect(editor.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toHaveCount(0);
});

test("AC4: completing a parent with open subtasks asks for confirmation, then completes them; reopening makes it open", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "complete", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const parent = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("parent") });
  const parentId = parent.json.task.id as string;
  const child = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("child"), parentId });
  const childId = child.json.task.id as string;

  await admin.page.goto(`/projects/${project.id}?task=${parentId}`);
  const dialog = admin.page.getByRole("dialog", { name: "Task" });
  await dialog.getByRole("button", { name: "Mark complete" }).click();
  const confirm = admin.page.getByRole("dialog", { name: "Open subtasks" });
  await expect(confirm).toContainText("1 open subtask");
  const refused = await admin.api.post(`/api/tasks/${parentId}/complete`, {});
  expect(refused.status).toBe(409);
  expect(refused.json.needsConfirm).toBe("open_subtasks");
  expect((await admin.api.get(`/api/tasks/${childId}`)).json.task.completedAt).toBeNull();

  await confirm.getByRole("button", { name: "Complete them all" }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${parentId}`)).json.task.completedAt).not.toBeNull();
  expect((await admin.api.get(`/api/tasks/${childId}`)).json.task.completedAt).not.toBeNull();
  expect((await admin.api.get(`/api/tasks/${parentId}`)).json.task.sectionId).toBe(project.done);

  expect((await admin.api.post(`/api/tasks/${parentId}/reopen`, {})).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${parentId}`)).json.task.completedAt).toBeNull();
  expect((await admin.api.get(`/api/tasks/${parentId}`)).json.task.sectionId).not.toBe(project.done);
});

test("AC5: a finished task with an approver waits for them, and they can approve or send it back", async ({ admin, browser, anon, later }) => {
  const assignee = await verifiedUser(browser, anon.request, "2468", "ac5-do");
  const approver = await verifiedUser(browser, anon.request, "2468", "ac5-ok");
  later(() => assignee.ctx.close());
  later(() => approver.ctx.close());
  later(() => deactivate(admin.api, assignee.user.id as string));
  later(() => deactivate(admin.api, approver.user.id as string));
  const project = await makeProject(admin.api, "approve", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: assignee.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: approver.user.id, role: "EDITOR" })).status).toBe(201);
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("review"), assigneeId: assignee.user.id });
  const id = created.json.task.id as string;
  expect((await admin.api.put(`/api/tasks/${id}/approver`, { approverId: approver.user.id })).status).toBe(200);

  expect((await assignee.api.post(`/api/tasks/${id}/send-for-approval`, {})).status).toBe(200);
  let task = (await approver.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.awaitingApproval).toBe(true);
  expect(task.assignee.id).toBe(approver.user.id);

  expect((await approver.api.post(`/api/tasks/${id}/send-back`, {})).status).toBe(200);
  task = (await assignee.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.awaitingApproval).toBe(false);
  expect(task.assignee.id).toBe(assignee.user.id);

  expect((await assignee.api.post(`/api/tasks/${id}/send-for-approval`, {})).status).toBe(200);
  expect((await approver.api.post(`/api/tasks/${id}/complete`, {})).status).toBe(200);
  task = (await approver.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.completedAt).not.toBeNull();
  expect(task.awaitingApproval).toBe(false);
});

test("AC6: a Viewer cannot write a task", async ({ admin, browser, anon, later }) => {
  const viewer = await verifiedUser(browser, anon.request, "2468", "ac6");
  later(() => viewer.ctx.close());
  later(() => deactivate(admin.api, viewer.user.id as string));
  const project = await makeProject(admin.api, "viewer", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: viewer.user.id, role: "VIEWER" })).status).toBe(201);
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("locked") });
  const id = created.json.task.id as string;

  for (const attempt of [
    () => viewer.api.post(`/api/projects/${project.id}/tasks`, { title: zz("nope") }),
    () => viewer.api.patch(`/api/tasks/${id}`, { title: zz("nope") }),
    () => viewer.api.post(`/api/tasks/${id}/complete`, {}),
    () => viewer.api.del(`/api/tasks/${id}`),
  ]) {
    const r = await attempt();
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("Viewers cannot make changes.");
  }
  expect((await viewer.api.get(`/api/tasks/${id}`)).status).toBe(200);
});

test.fixme("AC7: the automated task suite passes against the amended schema", async () => {
  // The criterion names "the automated test suite" and a historical count (47 on 17 October 2026) without a command or a file list.
  // It is not a behaviour of the running app, so it is not asserted here.
});
