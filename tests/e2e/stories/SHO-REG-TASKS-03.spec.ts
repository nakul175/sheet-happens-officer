import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { PW } from "../local-api";
import { newProject, newTask } from "../helpers/migration-2731";
import { expect, signInAs, zz } from "./qa";

test("SHO-REG-TASKS-03 two browser clients refuse a lost edit without a second action", async ({ admin, browser, later }) => {
  if (!local2691) throw new Error("Two-client conflict audit requires the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/task-two-client-conflict";
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const loaded = await admin.api.get(`/api/projects/${id}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.project.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedProjects, cleanup: true }, null, 2));
  });
  const project = await newProject(admin, later, { label: `two-client ${fixture}` }); ownedProjects.push(project.id);
  const sentinel = await newProject(admin, later, { label: `two-client sentinel ${fixture}` }); ownedProjects.push(sentinel.id);
  const taskId = await newTask(admin, project.id, { title: zz(`original ${fixture}`) });
  const sentinelBefore = await admin.api.get(`/api/projects/${sentinel.id}`);
  expect(sentinelBefore.status).toBe(200);
  const sentinelHash = createHash("sha256").update(JSON.stringify(sentinelBefore.json.project)).digest("hex");
  const second = await signInAs(browser, admin.user.email, PW);
  later(async () => { await second.ctx.close(); });

  await admin.page.goto(`/projects/${project.id}?task=${taskId}`);
  await second.page.goto(`/projects/${project.id}?task=${taskId}`);
  const firstSheet = admin.page.getByRole("dialog", { name: "Task", exact: true });
  const secondSheet = second.page.getByRole("dialog", { name: "Task", exact: true });
  const firstTitle = firstSheet.getByRole("textbox", { name: "Title", exact: true });
  const secondTitle = secondSheet.getByRole("textbox", { name: "Title", exact: true });
  await expect(firstTitle).toBeVisible();
  await expect(secondTitle).toHaveValue(await firstTitle.inputValue());

  const winnerTitle = zz(`first client wins ${fixture}`);
  const firstPatch = admin.page.waitForResponse(res => res.url().endsWith(`/api/tasks/${taskId}`) && res.request().method() === "PATCH");
  await firstTitle.fill(winnerTitle);
  await firstTitle.blur();
  expect((await firstPatch).status()).toBe(200);
  const winner = await admin.api.get(`/api/tasks/${taskId}`);
  expect(winner.status).toBe(200);
  expect(winner.json.task.title).toBe(winnerTitle);
  const activityAfterWinner = await admin.api.get(`/api/projects/${project.id}/activity`);
  expect(activityAfterWinner.status).toBe(200);

  const staleDraft = zz(`second client draft ${fixture}`);
  const secondPatch = second.page.waitForResponse(res => res.url().endsWith(`/api/tasks/${taskId}`) && res.request().method() === "PATCH");
  await secondTitle.fill(staleDraft);
  await secondTitle.blur();
  expect((await secondPatch).status()).toBe(409);
  await expect(secondSheet.getByRole("alert")).toContainText("Your change was not saved; the fields now show the current values.");
  await expect(secondSheet.getByRole("alert")).toContainText(staleDraft);
  await expect(secondTitle).toHaveValue(winnerTitle);
  const afterConflict = await admin.api.get(`/api/tasks/${taskId}`);
  expect(afterConflict.status).toBe(200);
  expect(afterConflict.json.task).toEqual(winner.json.task);
  const activityAfterConflict = await admin.api.get(`/api/projects/${project.id}/activity`);
  expect(activityAfterConflict.status).toBe(200);
  expect(activityAfterConflict.json.items).toEqual(activityAfterWinner.json.items);
  const sentinelAfter = await admin.api.get(`/api/projects/${sentinel.id}`);
  expect(sentinelAfter.status).toBe(200);
  expect(createHash("sha256").update(JSON.stringify(sentinelAfter.json.project)).digest("hex")).toBe(sentinelHash);

  mkdirSync(evidenceDir, { recursive: true });
  await secondSheet.screenshot({ path: `${evidenceDir}/stale-second-client.png` });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, firstStatus: 200, secondStatus: 409, winnerPreserved: true, draftRecoverable: true, activityUnchangedOnConflict: true, sentinelUnchanged: true }, null, 2));
});
