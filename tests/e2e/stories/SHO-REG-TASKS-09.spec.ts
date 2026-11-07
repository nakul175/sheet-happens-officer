import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject } from "../helpers/migration-2731";
import { expect, zz } from "./qa";

test("SHO-REG-TASKS-09 rapid Enter creates one dated task", async ({ admin, later }) => {
  if (!local2691) throw new Error("Quick-add audit case requires the guarded local test database.");
  const fixture = randomUUID();
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const row = await admin.api.get(`/api/projects/${id}`);
      expect(row.status).toBe(200);
      expect(row.json.project.archived).toBe(true);
    }
    mkdirSync("test-results/quick-add-double", { recursive: true });
    writeFileSync("test-results/quick-add-double/cleanup.json", JSON.stringify({ fixture, archivedProjects: ownedProjects }, null, 2));
  });
  const project = await newProject(admin, later, { label: "quick add double submit" }); ownedProjects.push(project.id);
  const sentinel = await newProject(admin, later, { label: "quick add sentinel" }); ownedProjects.push(sentinel.id);
  const sentinelBefore = await admin.api.get(`/api/projects/${sentinel.id}`);
  const fingerprint = createHash("sha256").update(JSON.stringify(sentinelBefore.json.project)).digest("hex");
  const title = zz("quick add once");
  const page = admin.page;
  await page.goto("/");
  await expect(page.getByRole("banner").getByRole("button", { name: "+ New task", exact: true })).toBeVisible();
  await page.keyboard.press("c");
  await page.locator("#qa-title").fill(title);
  await page.locator("#qa-proj").selectOption(project.id);
  await page.locator("#qa-date").fill("not a date");
  await expect(page.locator("#qa-date-note")).toContainText("Not a date I know");
  await expect(page.getByRole("dialog", { name: "New task" }).getByRole("button", { name: "Add task" })).toBeDisabled();
  await page.locator("#qa-date").fill("tomorrow");
  await expect(page.locator("#qa-date-note")).toContainText(/^Due /);

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route(`**/api/projects/${project.id}/tasks`, async route => {
    if (route.request().method() === "POST") {
      requests++;
      await held;
    }
    await route.continue();
  });
  const completed = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/tasks`) && response.request().method() === "POST");
  try {
    await page.locator("#qa-date").press("Enter");
    await expect.poll(() => requests).toBe(1);
    await page.keyboard.press("Enter");
    expect(requests).toBe(1);
    await expect(page.getByRole("dialog", { name: "New task" }).getByRole("button", { name: "Add task" })).toBeDisabled();
  } finally { release(); await completed; }
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
  const tasks = await admin.api.get(`/api/projects/${project.id}/tasks`);
  expect(tasks.status).toBe(200);
  const created = (tasks.json.sections as { tasks: { title: string; dueDate: string | null; assignee: { id: string } }[] }[])
    .flatMap(section => section.tasks).filter(task => task.title === title);
  expect(created).toHaveLength(1);
  expect(created[0].dueDate).toBeTruthy();
  expect(created[0].assignee.id).toBe(admin.user.id);
  const sentinelAfter = await admin.api.get(`/api/projects/${sentinel.id}`);
  expect(createHash("sha256").update(JSON.stringify(sentinelAfter.json.project)).digest("hex")).toBe(fingerprint);
  mkdirSync("test-results/quick-add-double", { recursive: true });
  writeFileSync("test-results/quick-add-double/verification.json", JSON.stringify({ fixture, requests, storedTasks: created.length, datePresent: true, sentinelUnchanged: true }, null, 2));
});
