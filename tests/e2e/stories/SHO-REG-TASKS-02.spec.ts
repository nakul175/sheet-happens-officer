import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject, postTaskCurrent } from "../helpers/migration-2731";
import { account } from "../local-api";
import { expect, zz } from "./qa";

test("SHO-REG-TASKS-02 workspace person picker confirms membership before assignment", async ({ admin, later }) => {
  if (!local2691) throw new Error("Workspace picker audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/workspace-assignee-picker";
  let projectId = "", personId = "";
  later(async () => {
    if (projectId) {
      const loaded = await admin.api.get(`/api/projects/${projectId}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.project.archived).toBe(true);
    }
    if (personId) {
      const loaded = await admin.api.get(`/api/team/${personId}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.person.status).toBe("DEACTIVATED");
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projectId, personId, cleanup: true }, null, 2));
  });
  const project = await newProject(admin, later, { label: `workspace picker ${fixture}` });
  projectId = project.id;
  const person = await account(zz(`picker target ${fixture}`), `nakul17+zz-tasks-02-${fixture}@aplyd.com`);
  personId = person.id;
  later(async () => {
    const response = await admin.api.post(`/api/team/${personId}/deactivate`, { reassign: "leaders" });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
  });

  const page = admin.page;
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "+ Add task", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add task", exact: true });
  const search = form.getByRole("textbox", { name: "Search workspace assignees" });
  await search.fill(person.name);
  await expect(form.getByText(`${person.name} · Not in this project`)).toBeVisible();
  await form.getByRole("button", { name: "Choose assignee" }).click();
  const confirm = page.getByRole("dialog", { name: `Add ${person.name} to this project?` });
  await expect(confirm).toContainText("will become an Editor");
  await confirm.getByRole("button", { name: "Add to project and assign" }).click();
  await expect(confirm).toHaveCount(0);
  const taskTitle = zz(`picker assigned ${fixture}`);
  await form.getByRole("textbox", { name: "Title" }).fill(taskTitle);
  await form.getByLabel("Due date").fill("2027-01-20");
  const create = page.waitForResponse(row => row.url().endsWith(`/api/projects/${project.id}/tasks`) && row.request().method() === "POST");
  await form.getByRole("button", { name: "Add task", exact: true }).click();
  expect((await create).status()).toBe(201);
  await expect(form).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(taskTitle, { exact: true }).first()).toBeVisible();
  const list = await admin.api.get(`/api/projects/${project.id}/tasks`);
  expect(list.status).toBe(200);
  const matches = (list.json.sections as { tasks: { id: string; title: string; assignee: { id: string } }[] }[])
    .flatMap(section => section.tasks).filter(task => task.title === taskTitle);
  expect(matches).toHaveLength(1);
  expect(matches[0].assignee.id).toBe(person.id);
  let projectState = await admin.api.get(`/api/projects/${project.id}`);
  expect((projectState.json.project.members as { userId: string; role: string }[]).filter(member => member.userId === person.id))
    .toEqual([expect.objectContaining({ userId: person.id, role: "EDITOR" })]);

  const removed = await admin.api.del(`/api/projects/${project.id}/members/${person.id}?handoverTo=${admin.user.id}`);
  expect(removed.status, JSON.stringify(removed.json)).toBe(204);
  const denied = await postTaskCurrent(admin, matches[0].id, "assign", { assigneeId: person.id });
  expect(denied.status).toBe(400);
  const retry = await postTaskCurrent(admin, matches[0].id, "assign", { assigneeId: person.id, addToProject: true });
  expect(retry.status, JSON.stringify(retry.json)).toBe(200);
  const reloaded = await admin.api.get(`/api/tasks/${matches[0].id}`);
  expect(reloaded.status).toBe(200);
  expect(reloaded.json.task.assignee.id).toBe(person.id);
  projectState = await admin.api.get(`/api/projects/${project.id}`);
  expect((projectState.json.project.members as { userId: string; role: string }[]).filter(member => member.userId === person.id))
    .toEqual([expect.objectContaining({ userId: person.id, role: "EDITOR" })]);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/task-after-reload.png` });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId, personId, taskId: matches[0].id, createdCount: 1, explicitEditorGrant: true, removedMembership: true, deniedRetryStatus: 400, explicitRetryStatus: 200, finalAssignee: person.id }, null, 2));
});
