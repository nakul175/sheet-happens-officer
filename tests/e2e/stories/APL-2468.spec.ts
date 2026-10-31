// APL-2468 · [SHO-E4] Tasks. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Names use ZZ-TEST. The Super Admin and the plain Member are the two people.
// Task writes send expectedUpdatedAt, which main requires (SHO-BUG-13).
import { readFileSync } from "node:fs";
import { login, type Api } from "../support";
import { runVitest } from "../helpers/named-suite";
import { test, makeProject, archiveProject, expect, zz } from "./qa";

const fixtureDueDate = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ request }) => {
  login("ADMIN");
  login("MEMBER");
  const res = await request.get("/api/health");
  const body = await res.text();
  expect(res.status(), body).toBe(200);
  const json = JSON.parse(body) as { ok?: boolean; release?: unknown };
  expect(json.ok).toBe(true);
  expect(typeof json.release === "string" && json.release.length >= 7, "release SHA from /api/health").toBe(true);
});

const calm = async (page: import("@playwright/test").Page) => {
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  if (await fold.count()) await fold.first().click();
};

async function version(api: Api, id: string) {
  const seen = (await api.get(`/api/tasks/${id}`)).json.task?.updatedAt as string;
  expect(seen, "the task's current updatedAt").toBeTruthy();
  return seen;
}

const calmPage = calm;

test("AC1: a Leader or Editor can create a task and one subtask, and a subtask of a subtask is refused", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "tasks", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);

  const parent = await member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("parent") });
  expect(parent.status, JSON.stringify(parent.json)).toBe(201);
  const parentId = parent.json.task.id as string;
  const child = await member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("child"), parentId });
  expect(child.status, JSON.stringify(child.json)).toBe(201);
  const childId = child.json.task.id as string;
  expect((await member.api.get(`/api/tasks/${parentId}`)).json.task.subtasks.total).toBe(1);
  expect((await member.api.get(`/api/tasks/${childId}`)).json.task.parentId).toBe(parentId);

  const nested = await member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("nested"), parentId: childId });
  expect(nested.status).toBe(400);
  expect(nested.json.error).toBe("A subtask cannot have subtasks.");
});

test("AC2: title, description, assignee, collaborators, due date and priority are saved and shown", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "details", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const created = await member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("draft") });
  const id = created.json.task.id as string;
  const title = zz("saved");
  const description = zz("notes");
  const saved = await member.api.patch(`/api/tasks/${id}`, {
    title, description, dueDate: "2026-11-02", priority: "HIGH", expectedUpdatedAt: await version(member.api, id),
  });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect((await member.api.post(`/api/tasks/${id}/assign`, { assigneeId: admin.user.id, expectedUpdatedAt: await version(member.api, id) })).status).toBe(200);
  expect((await member.api.post(`/api/tasks/${id}/collaborators`, { userId: member.user.id })).status).toBe(201);

  const task = (await member.api.get(`/api/tasks/${id}`)).json.task;
  expect(task).toMatchObject({ title, description, dueDate: "2026-11-02", priority: "HIGH" });
  expect(task.assignee.id).toBe(admin.user.id);
  expect((task.collaborators as { id: string }[]).map((c) => c.id)).toContain(member.user.id);

  await member.page.goto(`/projects/${project.id}?task=${id}`);
  const dialog = member.page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByLabel("Title")).toHaveValue(title);
  await expect(dialog.getByLabel("Description")).toHaveValue(description);
  await expect(dialog.getByLabel("Priority")).toHaveValue("HIGH");
  await expect(dialog.getByLabel("Due date")).toHaveValue("2026-11-02");
  await expect(dialog.getByLabel("Assignee")).toHaveValue(admin.user.id as string);
  await expect(dialog.locator(".chip", { hasText: String(member.user.name) })).toBeVisible();
});

test("AC3: setting or clearing Blocked shows on the task in every view", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "blocked", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("flagged");
  const created = await member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title, assigneeId: member.user.id });
  const id = created.json.task.id as string;
  expect((await member.api.patch(`/api/tasks/${id}`, {
    blocked: true, blockedReason: "Waiting on a file", expectedUpdatedAt: await version(member.api, id),
  })).status).toBe(200);

  const inList = async () => {
    const sections = (await member.api.get(`/api/projects/${project.id}/tasks`)).json.sections as { tasks: { id: string; blocked: boolean }[] }[];
    return sections.flatMap((s) => s.tasks).find((t) => t.id === id)?.blocked;
  };
  expect(await inList()).toBe(true);
  const mine = (await member.api.get("/api/my-tasks")).json;
  const groups = ["waitingOnMe", "waitingOnOthers", "overdue", "next7", "later"] as const;
  const row = groups.flatMap((g) => (mine[g] ?? []) as { id: string; blocked: boolean }[]).find((t) => t.id === id);
  expect(row?.blocked).toBe(true);

  await member.page.goto(`/projects/${project.id}`);
  await calmPage(member.page);
  await expect(member.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();
  await member.page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(member.page.locator(".bcard", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();
  // Home is the approved dashboard; the task-list assertion belongs to My tasks.
  await member.page.goto("/my-tasks");
  await expect(member.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toBeVisible();

  expect((await member.api.patch(`/api/tasks/${id}`, { blocked: false, expectedUpdatedAt: await version(member.api, id) })).status).toBe(200);
  expect(await inList()).toBe(false);
  await member.page.goto(`/projects/${project.id}`);
  await expect(member.page.locator(".item", { hasText: title }).locator(".chip.red", { hasText: "Blocked" })).toHaveCount(0);
});

test("AC4: completing a parent with open subtasks asks for confirmation, then completes them; reopening makes it open", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "complete", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const parent = await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("parent") });
  const parentId = parent.json.task.id as string;
  const child = await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("child"), parentId });
  const childId = child.json.task.id as string;

  await admin.page.goto(`/projects/${project.id}?task=${parentId}`);
  const dialog = admin.page.getByRole("dialog", { name: "Task" });
  await dialog.getByRole("button", { name: "Mark complete" }).click();
  const confirm = admin.page.getByRole("dialog", { name: "Open subtasks" });
  await expect(confirm).toContainText("1 open subtask");
  const refused = await admin.api.post(`/api/tasks/${parentId}/complete`, { expectedUpdatedAt: await version(admin.api, parentId) });
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

test("AC5: a finished task with an approver waits for them, and they can approve or send it back", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "approve", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("review"), assigneeId: member.user.id });
  const id = created.json.task.id as string;
  expect((await admin.api.put(`/api/tasks/${id}/approver`, { approverId: admin.user.id, expectedUpdatedAt: await version(admin.api, id) })).status).toBe(200);

  expect((await member.api.post(`/api/tasks/${id}/send-for-approval`, {})).status).toBe(200);
  let task = (await admin.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.awaitingApproval).toBe(true);
  expect(task.assignee.id).toBe(admin.user.id);

  expect((await admin.api.post(`/api/tasks/${id}/send-back`, {})).status).toBe(200);
  task = (await member.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.awaitingApproval).toBe(false);
  expect(task.assignee.id).toBe(member.user.id);

  expect((await member.api.post(`/api/tasks/${id}/send-for-approval`, {})).status).toBe(200);
  expect((await admin.api.post(`/api/tasks/${id}/complete`, { expectedUpdatedAt: await version(admin.api, id) })).status).toBe(200);
  task = (await admin.api.get(`/api/tasks/${id}`)).json.task;
  expect(task.completedAt).not.toBeNull();
  expect(task.awaitingApproval).toBe(false);
});

test("AC6: a Viewer cannot write a task", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "viewer", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("locked") });
  const id = created.json.task.id as string;

  for (const attempt of [
    () => member.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title: zz("nope") }),
    () => version(member.api, id).then((seen) => member.api.patch(`/api/tasks/${id}`, { title: zz("nope"), expectedUpdatedAt: seen })),
    () => version(member.api, id).then((seen) => member.api.post(`/api/tasks/${id}/complete`, { expectedUpdatedAt: seen })),
    () => member.api.del(`/api/tasks/${id}`),
  ]) {
    const r = await attempt();
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("Viewers cannot make changes.");
  }
  expect((await member.api.get(`/api/tasks/${id}`)).status).toBe(200);
});

const TASK_SPECS = [
  "tests/work.test.ts",
  "tests/undo.test.ts",
  "tests/approvals-14-16.test.ts",
  "tests/blocked-reason.test.ts",
  "tests/bulk-14-11.test.ts",
];

const SKIP_MARKER = /\b(?:it|test|describe)\.(?:skip|only|fixme|todo)\b|\b(?:xit|xdescribe|xtest)\s*\(|\bquarantine\b/;


test("AC7: the five task spec files pass, with none skipped", async () => {
  test.setTimeout(15 * 60_000);
  for (const file of TASK_SPECS) {
    const text = readFileSync(file, "utf8");
    expect(SKIP_MARKER.test(text), `${file} has a skip, .only, fixme or quarantine marker`).toBe(false);
    expect(text.includes("it("), `${file} contains tests`).toBe(true);
  }
  expect(process.env.SHO_NAMED_SUITE_DATABASE_URL ?? process.env.DATABASE_URL, "a configured disposable loopback DB is required for actual suite execution").toBeTruthy();
  const report = await runVitest(TASK_SPECS);
  expect(report.numPassedTests).toBe(report.numTotalTests);
  expect(report.testResults.map(file => file.name.split(/[\\/]/).at(-1)).sort()).toEqual(TASK_SPECS.map(file => file.split("/").at(-1)).sort());
});
