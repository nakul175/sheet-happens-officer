import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { account, PW } from "../local-api";
import { newProject, newTask } from "../helpers/migration-2731";
import { expect, signInAs, zz } from "./qa";

test("SHO-REG-TASKS-04 stale task-sheet edit shows current values and a recoverable draft", async ({ admin, later }) => {
  if (!local2691) throw new Error("Version browser audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-version-browser";
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, archivedProjects: ownedProjects, cleanup: true }, null, 2));
  });

  const project = await newProject(admin, later, { label: `version browser ${fixture}` }); ownedProjects.push(project.id);
  const sentinel = await newProject(admin, later, { label: `version sentinel ${fixture}` }); ownedProjects.push(sentinel.id);
  const taskId = await newTask(admin, project.id, { title: zz(`version original ${fixture}`) });
  const sentinelBefore = await admin.api.get(`/api/projects/${sentinel.id}`);
  expect(sentinelBefore.status).toBe(200);
  const sentinelHash = createHash("sha256").update(JSON.stringify(sentinelBefore.json.project)).digest("hex");

  const page = admin.page;
  await page.goto(`/projects/${project.id}?task=${taskId}`);
  const sheet = page.getByRole("dialog", { name: "Task", exact: true });
  const title = sheet.getByRole("textbox", { name: "Title", exact: true });
  await expect(title).toBeVisible();
  const loaded = await admin.api.get(`/api/tasks/${taskId}`);
  expect(loaded.status).toBe(200);
  const serverTitle = zz(`server edit ${fixture}`);
  const external = await admin.api.patch(`/api/tasks/${taskId}`, { title: serverTitle, expectedUpdatedAt: loaded.json.task.updatedAt });
  expect(external.status).toBe(200);

  const draftTitle = zz(`my draft ${fixture}`);
  const conflict = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${taskId}`) && response.request().method() === "PATCH");
  await title.fill(draftTitle);
  await title.blur();
  expect((await conflict).status()).toBe(409);
  const alert = sheet.getByRole("alert");
  await expect(alert).toContainText("Your change was not saved; the fields now show the current values.");
  await expect(alert).toContainText(`Your edit was: Title: "${draftTitle}"`);
  await expect(title).toHaveValue(serverTitle);
  mkdirSync(evidenceDir, { recursive: true });
  await sheet.screenshot({ path: `${evidenceDir}/stale-sheet.png` });

  const retry = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${taskId}`) && response.request().method() === "PATCH");
  await sheet.getByRole("button", { name: "Re-apply my edit" }).click();
  expect((await retry).status()).toBe(200);
  await expect(title).toHaveValue(draftTitle);
  const saved = await admin.api.get(`/api/tasks/${taskId}`);
  expect(saved.status).toBe(200);
  expect(saved.json.task.title).toBe(draftTitle);
  const sentinelAfter = await admin.api.get(`/api/projects/${sentinel.id}`);
  expect(sentinelAfter.status).toBe(200);
  expect(createHash("sha256").update(JSON.stringify(sentinelAfter.json.project)).digest("hex")).toBe(sentinelHash);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, firstStatus: 409, retryStatus: 200, currentTitleShown: true, draftRecovered: true, sentinelUnchanged: true }, null, 2));
});

test("SHO-REG-TASKS-04 missing and malformed version errors keep the task-sheet draft", async ({ admin, later }) => {
  if (!local2691) throw new Error("Version browser audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-version-browser";
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/invalid-version-cleanup.json`, JSON.stringify({ fixture, archivedProjects: ownedProjects, cleanup: true }, null, 2));
  });
  const project = await newProject(admin, later, { label: `version invalid ${fixture}` });
  ownedProjects.push(project.id);
  const original = zz(`version original ${fixture}`);
  const taskId = await newTask(admin, project.id, { title: original });
  const page = admin.page;
  await page.goto(`/projects/${project.id}?task=${taskId}`);
  const sheet = page.getByRole("dialog", { name: "Task", exact: true });
  const title = sheet.getByRole("textbox", { name: "Title", exact: true });
  await expect(title).toHaveValue(original);

  const cases = [
    { name: "absent", value: undefined, code: "version_required", message: "expectedUpdatedAt is required" },
    { name: "null", value: null, code: "version_required", message: "expectedUpdatedAt is required" },
    { name: "empty", value: "", code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
    { name: "malformed", value: "abc", code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
  ] as const;
  for (const item of cases) {
    const draft = zz(`${item.name} draft ${fixture}`);
    const intercept = async (route: import("@playwright/test").Route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      delete body.expectedUpdatedAt;
      if (item.value !== undefined) body.expectedUpdatedAt = item.value;
      await route.continue({ postData: JSON.stringify(body) });
    };
    await page.route(`**/api/tasks/${taskId}`, intercept);
    try {
      const response = page.waitForResponse(res => res.url().endsWith(`/api/tasks/${taskId}`) && res.request().method() === "PATCH");
      await title.fill(draft);
      await title.blur();
      const denied = await response;
      expect(denied.status()).toBe(400);
      expect(await denied.json()).toEqual({ error: { code: item.code, message: item.message } });
      await expect(sheet.getByRole("alert")).toContainText(item.message);
      await expect(title).toHaveValue(draft);
      const stored = await admin.api.get(`/api/tasks/${taskId}`);
      expect(stored.status).toBe(200);
      expect(stored.json.task.title).toBe(original);
    } finally {
      await page.unroute(`**/api/tasks/${taskId}`, intercept);
    }
  }
  mkdirSync(evidenceDir, { recursive: true });
  await sheet.screenshot({ path: `${evidenceDir}/invalid-version-sheet.png` });
  writeFileSync(`${evidenceDir}/invalid-version-verification.json`, JSON.stringify({ fixture, taskId, cases: cases.map(({ name, code }) => ({ name, code, status: 400 })), draftRetained: true, storedTitleUnchanged: true, fixtureProjectArchiveRegistered: true }, null, 2));
});

test("SHO-REG-TASKS-04 editor, viewer and outsider task-sheet boundaries", async ({ admin, later, browser }) => {
  if (!local2691) throw new Error("Version role audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-version-browser";
  const ownedPeople: string[] = [];
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    for (const id of ownedPeople) {
      const result = await admin.api.get(`/api/team/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe("DEACTIVATED");
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/role-cleanup.json`, JSON.stringify({ fixture, ownedPeople, ownedProjects, cleanup: true }, null, 2));
  });
  const people = {} as Record<"editor" | "viewer" | "outsider", Awaited<ReturnType<typeof account>>>;
  for (const role of ["editor", "viewer", "outsider"] as const) {
    const person = await account(zz(`version ${role}`), `nakul17+zz-tasks-04-${fixture}-${role}@aplyd.com`);
    people[role] = person;
    ownedPeople.push(person.id);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
  }
  const project = await newProject(admin, later, { label: `version roles ${fixture}` });
  ownedProjects.push(project.id);
  for (const [person, role] of [[people.editor, "EDITOR"], [people.viewer, "VIEWER"]] as const) {
    const added = await admin.api.post(`/api/projects/${project.id}/members`, { userId: person.id, role });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  const original = zz(`version role task ${fixture}`);
  const taskId = await newTask(admin, project.id, { title: original });
  const editor = await signInAs(browser, people.editor.email, PW);
  const viewer = await signInAs(browser, people.viewer.email, PW);
  const outsider = await signInAs(browser, people.outsider.email, PW);
  later(async () => { await editor.ctx.close(); await viewer.ctx.close(); await outsider.ctx.close(); });

  await editor.page.goto(`/projects/${project.id}?task=${taskId}`);
  const editorTitle = editor.page.getByRole("dialog", { name: "Task", exact: true }).getByRole("textbox", { name: "Title", exact: true });
  await expect(editorTitle).toHaveValue(original);
  await expect(editorTitle).not.toHaveJSProperty("readOnly", true);
  const edited = zz(`editor version ${fixture}`);
  const editorPatch = editor.page.waitForResponse(res => res.url().endsWith(`/api/tasks/${taskId}`) && res.request().method() === "PATCH");
  await editorTitle.fill(edited);
  await editorTitle.blur();
  expect((await editorPatch).status()).toBe(200);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.title).toBe(edited);

  await viewer.page.goto(`/projects/${project.id}?task=${taskId}`);
  const viewerSheet = viewer.page.getByRole("dialog", { name: "Task", exact: true });
  await expect(viewerSheet.getByRole("textbox", { name: "Title", exact: true })).toHaveJSProperty("readOnly", true);
  await expect(viewerSheet.getByRole("note")).toContainText("Viewer access");
  const invalid = { title: zz(`denied version ${fixture}`), expectedUpdatedAt: "abc" };
  const viewerDenied = await viewer.api.patch(`/api/tasks/${taskId}`, invalid);
  expect(viewerDenied.status).toBe(403);

  const hidden = await outsider.api.patch(`/api/tasks/${taskId}`, invalid);
  const missing = await outsider.api.patch(`/api/tasks/missing-${fixture}`, invalid);
  expect(hidden.status).toBe(404);
  expect(hidden.json).toEqual(missing.json);
  await outsider.page.goto(`/tasks/${taskId}`);
  await expect(outsider.page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
  await expect(outsider.page.getByText(edited)).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  await viewerSheet.screenshot({ path: `${evidenceDir}/viewer-read-only.png` });
  await outsider.page.screenshot({ path: `${evidenceDir}/outsider-hidden.png` });
  writeFileSync(`${evidenceDir}/role-verification.json`, JSON.stringify({ fixture, taskId, editorStatus: 200, viewerStatus: 403, outsiderStatus: 404, hiddenMissingSameBody: true, viewerReadOnly: true, outsiderNoTaskTitle: true }, null, 2));
});
