import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, local2691 } from "../helpers/2691-admin";
import { newProject, newTask, postTaskCurrent } from "../helpers/migration-2731";
import { account, PW } from "../local-api";
import { expect, signInAs, zz } from "./qa";

test("SHO-REG-TASKS-07 moves sections only inside one project and Undo restores the section", async ({ admin, later, browser }) => {
  if (!local2691) throw new Error("Task section-move audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-section-move-browser";
  let sourceId = "";
  let foreignId = "";
  let organisationId = "";
  let viewerId = "";
  later(async () => {
    if (!sourceId || !foreignId) return;
    const source = await admin.api.get(`/api/projects/${sourceId}`);
    const foreign = await admin.api.get(`/api/projects/${foreignId}`);
    expect(source.status).toBe(200);
    expect(foreign.status).toBe(200);
    expect(source.json.project.archived).toBe(true);
    expect(foreign.json.project.archived).toBe(true);
    if (viewerId) {
      const person = await admin.api.get(`/api/team/${viewerId}`);
      expect(person.status).toBe(200);
      expect(person.json.person.status).toBe("DEACTIVATED");
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, sourceId, foreignId, viewerId, projectsArchived: true, viewerDeactivated: true, cleanup: true }, null, 2));
  });
  const organisation = await admin.api.post("/api/orgs", { name: zz("section move linked organisation") });
  expect(organisation.status, JSON.stringify(organisation.json)).toBe(201);
  organisationId = organisation.json.organisation.id as string;
  later(async () => {
    const archived = await admin.api.post(`/api/orgs/${organisationId}/archive`, { archive: true });
    expect(archived.status, JSON.stringify(archived.json)).toBe(200);
  });
  const source = await newProject(admin, later, { label: "section move source" });
  sourceId = source.id;
  const foreign = await newProject(admin, later, { label: "section move foreign sentinel" });
  foreignId = foreign.id;
  const title = zz("section move parent");
  const taskId = await newTask(admin, source.id, { title });
  const childId = await newTask(admin, source.id, { title: zz("section move child"), parentId: taskId });
  const linked = await postTaskCurrent(admin, taskId, "links", { organisationId });
  expect(linked.status, JSON.stringify(linked.json)).toBe(201);
  const read = async () => admin.api.get(`/api/tasks/${taskId}`);
  const before = await read();
  expect(before.status).toBe(200);
  expect(before.json.task.links).toHaveLength(1);
  expect(before.json.task.links[0].organisation.id).toBe(organisationId);
  const childBefore = await admin.api.get(`/api/tasks/${childId}`);
  expect(childBefore.status).toBe(200);
  const viewer = await account(zz("section move viewer"), `nakul17+zz-tasks-07-${fixture}@aplyd.com`);
  viewerId = viewer.id;
  later(async () => {
    expect((await admin.api.post(`/api/team/${viewer.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  });
  expect((await admin.api.post(`/api/projects/${source.id}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  expect((await viewer.c.get(`/api/tasks/${taskId}`)).status).toBe(200);
  expect((await viewer.c.post(`/api/tasks/${taskId}/move`, { sectionId: source.doing, expectedUpdatedAt: before.json.task.updatedAt })).status).toBe(403);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task).toEqual(before.json.task);
  const viewerSession = await signInAs(browser, viewer.email, PW);
  try {
    await viewerSession.page.goto(`/projects/${source.id}?task=${taskId}`);
    const viewerDialog = viewerSession.page.getByRole("dialog", { name: "Task", exact: true });
    await expect(viewerDialog).toBeVisible();
    await expect(viewerDialog.getByRole("combobox", { name: "Section" })).toHaveCount(0);
  } finally { await viewerSession.ctx.close(); }
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
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, childId, sourceId, foreignId, organisationId, linkedRecordPreserved: true, viewerMoveDenied: true, viewerSectionControlHidden: true, foreignSectionRejected: true, mobileWidth: 390, movedWithinProject: true, relatedStatePreserved: true, undoRestoredSection: true, replayRejected: true, foreignProjectPreserved: true }, null, 2));
});
