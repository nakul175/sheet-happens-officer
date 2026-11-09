import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, local2691 } from "../helpers/2691-admin";
import { newProject, newTask } from "../helpers/migration-2731";
import { expect, zz } from "./qa";

test("SHO-REG-TASKS-07 moves sections only inside one project and Undo restores the section", async ({ admin, later }) => {
  if (!local2691) throw new Error("Task section-move audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-section-move-browser";
  let sourceId = "";
  let foreignId = "";
  later(async () => {
    if (!sourceId || !foreignId) return;
    const source = await admin.api.get(`/api/projects/${sourceId}`);
    const foreign = await admin.api.get(`/api/projects/${foreignId}`);
    expect(source.status).toBe(200);
    expect(foreign.status).toBe(200);
    expect(source.json.project.archived).toBe(true);
    expect(foreign.json.project.archived).toBe(true);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, sourceId, foreignId, projectsArchived: true, cleanup: true }, null, 2));
  });
  const source = await newProject(admin, later, { label: "section move source" });
  sourceId = source.id;
  const foreign = await newProject(admin, later, { label: "section move foreign sentinel" });
  foreignId = foreign.id;
  const title = zz("section move parent");
  const taskId = await newTask(admin, source.id, { title });
  const childId = await newTask(admin, source.id, { title: zz("section move child"), parentId: taskId });
  const read = async () => admin.api.get(`/api/tasks/${taskId}`);
  const before = await read();
  expect(before.status).toBe(200);
  const childBefore = await admin.api.get(`/api/tasks/${childId}`);
  expect(childBefore.status).toBe(200);
  const foreignBefore = (await admin.api.get(`/api/projects/${foreign.id}`)).json.project;
  const foreignHash = createHash("sha256").update(JSON.stringify(foreignBefore)).digest("hex");
  const related = (task: typeof before.json.task) => ({
    projectId: task.projectId,
    parentId: task.parentId,
    assigneeId: task.assignee?.id,
    approverId: task.approver?.id,
    collaborators: (task.collaborators as { id: string }[]).map(person => person.id).sort(),
    subtasks: (task.subtaskList as { id: string }[]).map(item => item.id).sort(),
    links: task.links,
  });

  const refused = await admin.api.post(`/api/tasks/${taskId}/move`, { sectionId: foreign.doing, expectedUpdatedAt: before.json.task.updatedAt });
  expect(refused.status).toBe(404);
  const afterRefusal = await read();
  expect(afterRefusal.status).toBe(200);
  expect(afterRefusal.json.task).toEqual(before.json.task);
  expect((await admin.api.get(`/api/tasks/${childId}`)).json.task).toEqual(childBefore.json.task);

  const page = admin.page;
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/projects/${source.id}?task=${taskId}`);
  const dialog = page.getByRole("dialog", { name: "Task", exact: true });
  await expect(dialog).toBeVisible();
  const [movedResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/tasks/${taskId}/move`) && response.request().method() === "POST"),
    dialog.getByRole("combobox", { name: "Section" }).selectOption(source.doing),
  ]);
  expect(movedResponse.status()).toBe(200);
  await expect.poll(async () => (await read()).json.task.sectionId).toBe(source.doing);
  const moved = (await read()).json.task;
  expect(related(moved)).toEqual(related(before.json.task));
  expect((await admin.api.get(`/api/tasks/${childId}`)).json.task).toEqual(childBefore.json.task);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/moved.png`, fullPage: true });

  const activity = await admin.api.get(`/api/projects/${source.id}/activity`);
  expect(activity.status).toBe(200);
  const action = (activity.json.items as { id: string; what: string }[]).find(item => item.what.includes(title) && item.what.includes("moved"));
  expect(action).toBeDefined();
  const undone = await admin.api.post(`/api/actions/${action!.id}/undo`, {});
  expect(undone.status, JSON.stringify(undone.json)).toBe(200);
  const restored = await read();
  expect(restored.status).toBe(200);
  expect(restored.json.task.sectionId).toBe(source.todo);
  expect(related(restored.json.task)).toEqual(related(before.json.task));
  expect((await admin.api.get(`/api/tasks/${childId}`)).json.task).toEqual(childBefore.json.task);
  expect((await admin.api.post(`/api/actions/${action!.id}/undo`, {})).status).toBe(409);
  const foreignAfter = (await admin.api.get(`/api/projects/${foreign.id}`)).json.project;
  expect(createHash("sha256").update(JSON.stringify(foreignAfter)).digest("hex")).toBe(foreignHash);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, childId, sourceId, foreignId, foreignSectionRejected: true, mobileWidth: 390, movedWithinProject: true, relatedStatePreserved: true, undoRestoredSection: true, replayRejected: true, foreignProjectPreserved: true }, null, 2));
});
