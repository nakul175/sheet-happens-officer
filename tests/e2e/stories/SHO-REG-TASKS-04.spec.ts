import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject, newTask } from "../helpers/migration-2731";
import { expect, zz } from "./qa";

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
