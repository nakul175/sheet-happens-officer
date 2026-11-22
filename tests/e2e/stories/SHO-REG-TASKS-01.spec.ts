import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject } from "../helpers/migration-2731";
import { account, PW } from "../local-api";
import { expect, signInAs, zz } from "./qa";

test("SHO-REG-TASKS-01 task form validates and stores one assigned task", async ({ admin, later, browser }) => {
  if (!local2691) throw new Error("Task-create browser audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-create-browser";
  const ownedProjects: string[] = [];
  let viewerId = "";
  later(async () => {
    for (const id of ownedProjects) {
      const loaded = await admin.api.get(`/api/projects/${id}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.project.archived).toBe(true);
    }
    if (viewerId) {
      const loaded = await admin.api.get(`/api/team/${viewerId}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.person.status).toBe("DEACTIVATED");
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedProjects, viewerId, cleanup: true }, null, 2));
  });

  const project = await newProject(admin, later, { label: `task create ${fixture}` });
  ownedProjects.push(project.id);
  const viewerAccount = await account(zz(`task create viewer ${fixture}`), `nakul17+zz-tasks-01-${fixture}@aplyd.com`);
  viewerId = viewerAccount.id;
  later(async () => {
    const result = await admin.api.post(`/api/team/${viewerId}/deactivate`, { reassign: "leaders" });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
  });
  const membership = await admin.api.post(`/api/projects/${project.id}/members`, { userId: viewerId, role: "VIEWER" });
  expect(membership.status, JSON.stringify(membership.json)).toBe(201);
  const viewer = await signInAs(browser, viewerAccount.email, PW);
  later(() => viewer.ctx.close());
  await viewer.page.goto(`/projects/${project.id}`);
  await expect(viewer.page.getByRole("banner").getByRole("button", { name: "+ New task", exact: true })).toHaveCount(0);
  expect((await viewer.api.post(`/api/projects/${project.id}/tasks`, { title: zz("viewer denied"), dueDate: "2027-01-20" })).status).toBe(403);

  const page = admin.page;
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("banner").getByRole("button", { name: "+ New task", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  const title = form.getByRole("textbox", { name: "Title" });
  const add = form.getByRole("button", { name: "Add task" });
  await expect(add).toBeDisabled();
  await title.fill(" ");
  await expect(add).toBeDisabled();
  await title.fill("x".repeat(501));
  await expect(title).toHaveValue("x".repeat(500));
  await form.getByRole("textbox", { name: "Due date" }).fill("not a date");
  await expect(add).toBeDisabled();
  const taskTitle = zz(`task create saved ${fixture}`);
  await title.fill(taskTitle);
  await form.getByRole("textbox", { name: "Due date" }).fill("tomorrow");
  await form.getByLabel("Project").selectOption(project.id);
  await expect(add).toBeEnabled();
  const response = page.waitForResponse(row => row.url().endsWith(`/api/projects/${project.id}/tasks`) && row.request().method() === "POST");
  await add.click();
  expect((await response).status()).toBe(201);
  await expect(form).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(taskTitle, { exact: true }).first()).toBeVisible();
  const list = await admin.api.get(`/api/projects/${project.id}/tasks`);
  expect(list.status).toBe(200);
  const matches = (list.json.sections as { tasks: { id: string; title: string; assignee: { id: string }; dueDate: string | null }[] }[])
    .flatMap(section => section.tasks).filter(task => task.title === taskTitle);
  expect(matches).toHaveLength(1);
  expect(matches[0].assignee.id).toBe(admin.user.id);
  expect(matches[0].dueDate).toBeTruthy();
  const stored = await admin.api.get(`/api/tasks/${matches[0].id}`);
  expect(stored.status).toBe(200);
  expect(stored.json.task.title).toBe(taskTitle);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/task-after-reload.png` });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, taskId: matches[0].id, viewerCreateStatus: 403, blankBlocked: true, titleMaxLength: 500, badDateBlocked: true, storedTasks: matches.length, assigneeSelf: true, dueDatePresent: true }, null, 2));
});
