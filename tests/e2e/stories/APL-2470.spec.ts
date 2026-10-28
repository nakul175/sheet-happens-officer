// APL-2470 · [SHO-E6] Trash, action log and Undo. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
// Undo of deactivation and bulk reassignment is excluded, per the epic.
import { test, login } from "../support";
import { patchCurrent } from "../helpers/jim-http";
import { activityRow } from "../helpers/screen-row";
import {
  PASS, passwordOk, gate, verifiedUser, deactivate, makeProject, archiveProject, expect, zz,
} from "./qa";

test.beforeAll(async ({ request }) => {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

type Act = { id: string; who: string; what: string; when: string; ts: number; undo: string };

// qa:TC missing
test("AC1: deleting a task moves it to the project Trash, to be purged after 30 days", async ({ admin, browser, anon, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const editor = await verifiedUser(browser, anon.request, "2470", "ac1");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "trash", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("gone");
  const created = await editor.api.post(`/api/projects/${project.id}/tasks`, { title, description: zz("detail") });
  const id = created.json.task.id as string;
  expect((await editor.api.del(`/api/tasks/${id}`)).status).toBe(204);
  expect((await editor.api.get(`/api/tasks/${id}`)).status).toBe(404);

  const trash = await editor.api.get(`/api/projects/${project.id}/trash`);
  expect(trash.status).toBe(200);
  const item = (trash.json.items as { id: string; title: string; daysLeft: number }[]).find((t) => t.id === id);
  expect(item?.title).toBe(title);
  expect(item?.daysLeft).toBe(30);
  await editor.page.goto(`/projects/${project.id}/trash`);
  await expect(editor.page.getByText("Tasks are kept for 30 days, then removed for good.")).toBeVisible();
  await expect(editor.page.getByText(title)).toBeVisible();

  await admin.page.goto("/audit");
  await expect(admin.page.getByText("purge-trash")).toBeVisible();
  await expect(admin.page.getByText(/Removes tasks that have been in Trash for (?:more than )?30 days/)).toBeVisible();
});

// qa:TC missing
test("AC2: restoring a task from Trash puts it back in the project with its data", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const project = await makeProject(admin.api, "restore", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const title = zz("back");
  const description = zz("kept");
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title, description });
  const id = created.json.task.id as string;
  expect((await admin.api.del(`/api/tasks/${id}`)).status).toBe(204);
  await admin.page.goto(`/projects/${project.id}/trash`);
  const row = admin.page.getByRole("row", { name: new RegExp(title) });
  await row.getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${id}`)).status).toBe(200);
  const task = (await admin.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.title).toBe(title);
  expect(task.description).toBe(description);
  expect(task.projectId).toBe(project.id);
});

// qa:TC missing
test("AC3: a write records who, what, when and the before-state", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const project = await makeProject(admin.api, "log", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const before = zz("before");
  const after = zz("after");
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: before });
  const id = created.json.task.id as string;
  expect((await patchCurrent(admin, id, { title: after })).status).toBe(200);
  const items = (await admin.api.get(`/api/projects/${project.id}/activity`)).json.items as Act[];
  const row = items.find((item) => item.what.includes(before) && item.what.includes(after));
  expect(row, "the rename names the title from before the write").toBeTruthy();
  expect(row!.who).toBe(admin.user.name);
  expect(row!.when.length).toBeGreaterThan(0);
  expect(typeof row!.ts).toBe("number");
});

// qa:TC missing
test("AC4: Undo restores a task, a project and a membership change", async ({ admin, browser, anon, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const editor = await verifiedUser(browser, anon.request, "2470", "ac4");
  later(() => editor.ctx.close());
  later(() => deactivate(admin.api, editor.user.id as string));
  const project = await makeProject(admin.api, "undo", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);

  const before = zz("title");
  const after = zz("retitled");
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: before });
  const taskId = created.json.task.id as string;
  expect((await patchCurrent(admin, taskId, { title: after })).status).toBe(200);
  const renamed = zz("renamed project");
  expect((await admin.api.patch(`/api/projects/${project.id}`, { name: renamed })).status).toBe(200);
  expect((await admin.api.patch(`/api/projects/${project.id}/members/${editor.user.id}`, { role: "VIEWER" })).status).toBe(200);

  const undo = async (what: string, undone: string) => {
    await admin.page.goto(`/projects/${project.id}/activity`);
    const row = activityRow(admin.page, what === "Viewer" ? /to Viewer/ : `to "${what}"`);
    await expect(row, what).toHaveCount(1);
    await row.getByRole("button", { name: "Undo" }).click();
    // The toast names this undo. A previous "Undone:" line can still be on screen after the last one.
    await expect(admin.page.getByText(`Undone: ${undone}.`)).toBeVisible();
  };
  await undo(after, "task edited");
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.title).toBe(before);
  await undo(renamed, "project edited");
  await expect.poll(async () => (await admin.api.get(`/api/projects/${project.id}`)).json.project.name).toBe(project.name);
  await undo("Viewer", "role changed");
  await expect.poll(async () => {
    const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string; role: string }[];
    return members.find((m) => m.userId === editor.user.id)?.role;
  }).toBe("EDITOR");
});

// qa:TC missing
test("AC5: Undo warns when the data changed after the action, before it proceeds", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const project = await makeProject(admin.api, "conflict", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const original = zz("one");
  const second = zz("two");
  const third = zz("three");
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: original });
  const id = created.json.task.id as string;
  expect((await patchCurrent(admin, id, { title: second })).status).toBe(200);
  expect((await patchCurrent(admin, id, { title: third })).status).toBe(200);
  const items = (await admin.api.get(`/api/projects/${project.id}/activity`)).json.items as Act[];
  const first = items.find((item) => item.what.includes(original) && item.what.includes(second));
  expect(first?.undo).toBe("available");
  const warned = await admin.api.post(`/api/actions/${first!.id}/undo`, {});
  expect(warned.status).toBe(409);
  expect(warned.json.error).toBe("This changed after your action.");
  expect(warned.json.needsConfirm).toBe("conflict");
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.title).toBe(third);

  await admin.page.goto(`/projects/${project.id}/activity`);
  const row = activityRow(admin.page, original, second);
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Undo" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Undo conflict" });
  await expect(dialog.getByRole("heading", { name: "This changed after your action" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Undo anyway" })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep their change" }).click();
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.title).toBe(third);
});

// qa:TC missing
test("AC6: the Super Admin's organisation audit log shows org-level actions and what was acted on", async ({ admin, browser, anon, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const member = await verifiedUser(browser, anon.request, "2470", "ac6");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  expect((await member.api.get("/api/audit")).status).toBe(404);
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);

  const log = await admin.api.get("/api/audit?event=ADMIN_PROMOTED");
  expect(log.status).toBe(200);
  const items = log.json.items as { event: string; who: string; target: string | null }[];
  const hit = items.find((item) => item.target?.includes(member.name));
  expect(hit?.event).toBe("ADMIN_PROMOTED");
  expect(hit?.who).toBe(admin.user.name);

  await admin.page.goto("/audit");
  await expect(admin.page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const event = admin.page.getByLabel("Event");
  await event.selectOption("ADMIN_PROMOTED");
  await expect(event).toHaveValue("ADMIN_PROMOTED");
  await expect(admin.page.getByText(`Person "${member.name}"`)).toBeVisible();
});
