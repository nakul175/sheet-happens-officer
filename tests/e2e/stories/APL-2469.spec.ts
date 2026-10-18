// APL-2469 · [SHO-E5] Views and screens. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
import type { Page } from "@playwright/test";
import { test, login } from "../support";
import { why } from "../helpers/jim-http";
import { PASS, passwordOk, gate, verifiedUser, deactivate, makeProject, archiveProject, expect, zz, RUN } from "./qa";

test.beforeAll(async ({ request }) => {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  await gate(request);
});

const calm = async (page: Page) => {
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  if (await fold.count()) await fold.first().click();
};

test("AC1: opening the app lands on My tasks and shows the member's open tasks", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2469", "ac1");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  const project = await makeProject(admin.api, "home", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("mine");
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { title, assigneeId: member.user.id })).status).toBe(201);

  await member.page.goto("/");
  await expect(member.page).toHaveURL(/\/$/);
  await expect(member.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(member.page.getByText(/open task/)).toBeVisible();
  await expect(member.page.locator(".item", { hasText: title })).toBeVisible();
});

test("AC2: the project list view lists the tasks a member can see, with their key fields", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2469", "ac2");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  const project = await makeProject(admin.api, "list", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("listed");
  const created = await member.api.post(`/api/projects/${project.id}/tasks`, {
    title, assigneeId: member.user.id, dueDate: "2026-11-02", priority: "HIGH",
  });
  expect(created.status).toBe(201);
  const sections = (await member.api.get(`/api/projects/${project.id}/tasks`)).json.sections as { tasks: { title: string; priority: string; dueDate: string; assignee: { id: string } }[] }[];
  const task = sections.flatMap((s) => s.tasks).find((t) => t.title === title);
  expect(task).toMatchObject({ priority: "HIGH", dueDate: "2026-11-02", assignee: { id: member.user.id } });

  await member.page.goto(`/projects/${project.id}`);
  await calm(member.page);
  const row = member.page.locator(".item", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator(".pri-t")).toHaveText("High");
});

test("AC3: the board shows tasks in Section columns, and a Leader can add, rename, reorder, delete and mark the done Section", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "board", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const title = zz("card");
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { title })).status).toBe(201);
  const sectionName = `ZZ ${RUN.slice(-4)}`;

  await admin.page.goto(`/projects/${project.id}?view=board`);
  await calm(admin.page);
  await expect(admin.page.locator(`.col[aria-label="To do"] .bcard`, { hasText: title })).toBeVisible();
  await expect(admin.page.locator('.col[aria-label="In progress"]')).toBeVisible();
  await expect(admin.page.locator('.col[aria-label="Done"]')).toBeVisible();

  await admin.page.getByRole("button", { name: "+ Add section" }).click();
  await admin.page.getByLabel("Section name").fill(sectionName);
  await admin.page.getByRole("button", { name: "Add section", exact: true }).click();
  await expect(admin.page.locator(`.col[aria-label="${sectionName}"]`)).toBeVisible();

  await admin.page.getByRole("button", { name: `Section menu for ${sectionName}` }).click();
  await admin.page.getByRole("menuitem", { name: "Rename" }).click();
  await admin.page.getByLabel("Section name").fill(`${sectionName} 2`);
  await admin.page.getByRole("button", { name: "Save" }).click();
  await expect(admin.page.locator(`.col[aria-label="${sectionName} 2"]`)).toBeVisible();

  await admin.page.getByRole("button", { name: `Section menu for ${sectionName} 2` }).click();
  await admin.page.getByRole("menuitem", { name: "Move left" }).click();
  await expect.poll(async () => {
    const names = (await admin.api.get(`/api/projects/${project.id}`)).json.project.sections as { name: string }[];
    return names.map((s) => s.name).indexOf(`${sectionName} 2`);
  }).toBeLessThan(3);

  await admin.page.getByRole("button", { name: `Section menu for ${sectionName} 2` }).click();
  await admin.page.getByRole("menuitem", { name: "Delete…" }).click();
  await admin.page.getByRole("button", { name: "Delete section" }).click();
  await expect(admin.page.locator(`.col[aria-label="${sectionName} 2"]`)).toHaveCount(0);

  await admin.page.getByRole("button", { name: "Section menu for In progress" }).click();
  await admin.page.getByRole("menuitem", { name: "Treat as done" }).click();
  await expect.poll(async () => {
    const sections = (await admin.api.get(`/api/projects/${project.id}`)).json.project.sections as { name: string; isDone: boolean }[];
    return sections.find((s) => s.name === "In progress")?.isDone;
  }).toBe(true);
  const sections = (await admin.api.get(`/api/projects/${project.id}`)).json.project.sections as { name: string; isDone: boolean }[];
  expect(sections.find((s) => s.name === "Done")?.isDone).toBe(false);
});

test("AC4: opening a task row or card shows the detail overlay without leaving the page", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "overlay", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const title = zz("open");
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { title })).status).toBe(201);

  await admin.page.goto(`/projects/${project.id}`);
  await calm(admin.page);
  await admin.page.locator(".item", { hasText: title }).click();
  await expect(admin.page.getByRole("dialog", { name: "Task" })).toBeVisible();
  await expect(admin.page).toHaveURL(new RegExp(`/projects/${project.id}\\?task=`));
  expect(new URL(admin.page.url()).pathname).toBe(`/projects/${project.id}`);

  await admin.page.goto(`/projects/${project.id}?view=board`);
  await calm(admin.page);
  await admin.page.locator(".bcard", { hasText: title }).click();
  await expect(admin.page.getByRole("dialog", { name: "Task" })).toBeVisible();
  expect(new URL(admin.page.url()).pathname).toBe(`/projects/${project.id}`);
});

test("AC5: the Team page lists people as specified in SHO-US-2.5", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2469", "ac5");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  await admin.page.goto("/team");
  await expect(admin.page.getByRole("heading", { name: "Team" })).toBeVisible();
  for (const heading of ["Name", "Email", "Role", "Status", "Actions"]) {
    await expect(admin.page.getByRole("columnheader", { name: heading, exact: true })).toBeVisible();
  }
  const row = admin.page.locator("tr", { hasText: member.email });
  await expect(row).toContainText(member.name);
  await expect(row).toContainText("Member");
  await expect(row).toContainText("Active");
  await row.getByRole("link", { name: member.name }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/team/${member.user.id}$`));
  await expect(admin.page.getByRole("heading", { name: member.name })).toBeVisible();
});

test("AC6: the branded shell works on a desktop and a phone-width browser", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "shell", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const screens = ["/", "/projects", "/team", `/projects/${project.id}`];

  await admin.page.setViewportSize({ width: 1400, height: 900 });
  for (const path of screens) {
    await admin.page.goto(path);
    const brand = await admin.page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const side = document.querySelector("aside.side");
      return {
        navy: css.getPropertyValue("--navy").trim().toLowerCase(),
        gold: css.getPropertyValue("--gold").trim().toLowerCase(),
        side: side ? getComputedStyle(side).backgroundColor : "",
      };
    });
    expect(brand.navy).toBe("#2c2f71");
    expect(brand.gold).toBe("#d99d29");
    expect(brand.side).toBe("rgb(44, 47, 113)");
    await expect(admin.page.getByRole("heading").first()).toBeVisible();
  }
  await admin.page.goto("/");
  await expect(admin.page.locator('aside.dock[aria-label="Concierge"]')).toBeVisible();

  await admin.page.setViewportSize({ width: 390, height: 844 });
  for (const path of screens) {
    await admin.page.goto(path);
    await expect(admin.page.locator(".tabbar")).toBeVisible();
    await expect(admin.page.locator('button.fab[aria-label="Concierge"]')).toBeVisible();
    const overflow = await admin.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow, `${path} stays within the phone width`).toBe(true);
  }
});

const MOCKUP_SCREENS = [
  ["My tasks", "By date groups, task rows, quick add"],
  ["Project list", "column headers, task rows, Blocked flag"],
  ["Project board", "Section columns, cards, add Section"],
  ["Task detail", "overlay over the page, fields, subtasks"],
  ["Team", "people grouped by role, deactivated shown"],
] as const;

test.skip(
  "AC7: each screen matches the approved mockup at 1440x900 and 390x844 (manual visual check)",
  why(MOCKUP_SCREENS.map(([screen, keys]) =>
    `${screen} at desktop 1440x900 and phone 390x844: confirm side by side with the Design canvas mockup — app shell with navy #2C2F71 header and gold #D99D29 accent, concierge dock at the bottom, key elements in the mockup's order (${keys}). No element clipped, overlapping or horizontally scrolling. Attach a screenshot of this screen at each viewport. Spacing and copy differences are noted, not failed, unless an element is missing or misplaced.`,
  ).join(" ")),
  () => {},
);
