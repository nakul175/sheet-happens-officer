import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, local2691 } from "../helpers/2691-admin";
import { deleteFixtureTask, newProject, newTask } from "../helpers/migration-2731";
import { expect, RUN } from "../support";

test("SHO-REG-SEARCH-04: Search page and palette open the same owned task", async ({ admin, later }) => {
  if (!local2691) throw new Error("This Search parity audit uses only the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/search-palette-parity";
  let projectId = "", taskId = "";
  later(async () => {
    if (!projectId) return;
    const project = await admin.api.get(`/api/projects/${projectId}`);
    expect(project.status).toBe(200);
    expect(project.json.project.archived).toBe(true);
    if (taskId) expect((await admin.api.get(`/api/tasks/${taskId}`)).status).toBe(404);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projectId, taskId, projectArchived: true, taskDeleted: Boolean(taskId), cleanup: true }, null, 2));
  });

  const word = `Parity${RUN}`;
  const title = `${word} task`;
  const project = await newProject(admin, later, { label: "search palette parity" });
  projectId = project.id;
  taskId = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  later(() => deleteFixtureTask(admin, taskId));
  const page = admin.page;

  await page.goto("/search");
  await page.getByRole("searchbox", { name: "Search" }).fill(word);
  const pageResult = page.getByRole("link", { name: new RegExp(title) });
  await expect(pageResult).toBeVisible();
  await expect(pageResult).toHaveAttribute("href", `/projects/${project.id}?task=${taskId}`);
  await pageResult.click();
  await expect(page).toHaveURL(new RegExp(`task=${taskId}`));
  await expect(page.getByRole("dialog", { name: "Task", exact: true })).toContainText(title);

  await page.goto("/projects");
  await expect(page.getByRole("banner").getByRole("button", { name: "+ New task", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await expect(palette).toHaveCount(1);
  await page.getByRole("combobox", { name: /Search tasks/ }).fill(word);
  const paletteResult = palette.getByRole("option").filter({ hasText: title });
  await expect(paletteResult).toBeVisible();
  await expect(paletteResult).toContainText(project.name);
  await paletteResult.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}`));
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(palette).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId, taskId, pageHref: `/projects/${projectId}?task=${taskId}`, paletteHref: `/tasks/${taskId}`, sameOwnedTask: true, paletteClosed: true }, null, 2));
});
