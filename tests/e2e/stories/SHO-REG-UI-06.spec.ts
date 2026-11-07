import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject } from "../helpers/migration-2731";
import { expect, zz } from "./qa";

test("SHO-REG-UI-06: phone density survives navigation and reload without clipping task controls", async ({ admin, later }) => {
  if (!local2691) throw new Error("This UI audit journey requires the guarded local test database.");
  const fixture = randomUUID();
  const prior = await admin.api.get("/api/profile/density");
  expect(prior.status).toBe(200);
  const { compact } = prior.json as { compact: boolean };
  let projectId = "";
  later(async () => {
    const restored = await admin.api.get("/api/profile/density");
    expect(restored.status).toBe(200);
    expect(restored.json).toEqual({ compact });
    const archived = await admin.api.get(`/api/projects/${projectId}`);
    expect(archived.status).toBe(200);
    expect(archived.json.project.archived).toBe(true);
    mkdirSync("test-results/density-phone", { recursive: true });
    writeFileSync("test-results/density-phone/cleanup.json", JSON.stringify({ fixture, restored: true, projectId, projectArchived: true }, null, 2));
  });
  later(() => admin.api.put("/api/profile/density", { compact }));
  expect((await admin.api.put("/api/profile/density", { compact: false })).status).toBe(200);
  const project = await newProject(admin, later, { label: "density phone" });
  projectId = project.id;
  const title = zz("density phone task");
  const created = await admin.api.post(`/api/projects/${project.id}/tasks`, { title, assigneeId: admin.user.id, dueDate: "2030-01-15" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);

  const page = admin.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${project.id}`);
  const shell = page.locator(".shell");
  await expect(shell).not.toHaveAttribute("data-density");
  const utilities = page.getByRole("button", { name: /^Account and utilities, \S+$/ });
  await utilities.click();
  await page.getByRole("button", { name: /Compact/ }).click();
  await expect(shell).toHaveAttribute("data-density", "compact");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await admin.api.get("/api/profile/density")).json).toEqual({ compact: true });
  await page.setViewportSize({ width: 390, height: 844 });

  const check = async () => {
    await expect(page.getByText(title).first()).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "+ New task", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Concierge", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  };
  await check();
  await page.goto("/my-tasks");
  await expect(shell).toHaveAttribute("data-density", "compact");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await check();
  await page.reload();
  await expect(shell).toHaveAttribute("data-density", "compact");
  await check();
  await page.setViewportSize({ width: 1440, height: 900 });
  await utilities.click();
  await page.getByRole("button", { name: /Compact/ }).click();
  await expect(shell).not.toHaveAttribute("data-density");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await admin.api.get("/api/profile/density")).json).toEqual({ compact: false });
  expect((await admin.api.put("/api/profile/density", { compact })).status).toBe(200);
});
