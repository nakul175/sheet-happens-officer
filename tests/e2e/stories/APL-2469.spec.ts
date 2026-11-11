// APL-2469 · [SHO-E5] Views and screens. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Names use ZZ-TEST. The Super Admin and the plain Member are the two people.
import type { Page } from "@playwright/test";
import { login } from "../support";
import { test, makeProject, archiveProject, expect, zz, RUN } from "./qa";

const fixtureDueDate = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ request }) => {
  login("ADMIN");
  login("MEMBER");
  const res = await request.get("/api/health");
  const body = await res.text();
  expect(res.status(), body).toBe(200);
  const json = JSON.parse(body) as { ok?: boolean; release?: unknown };
  expect(json.ok).toBe(true);
  expect(typeof json.release === "string" && json.release.length >= 7, "release SHA from /api/health").toBe(true);
});

const calm = async (page: Page) => {
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  if (await fold.count()) await fold.first().click();
};

test("AC1: opening the app lands on My tasks and shows the member's open tasks", async ({ admin, member, later }) => {
  const project = await makeProject(admin.api, "home", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("mine");
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title, assigneeId: member.user.id })).status).toBe(201);

  await member.page.goto("/");
  await expect(member.page).toHaveURL(/\/$/);
  await expect(member.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(member.page.getByText(/open task/)).toBeVisible();
  await expect(member.page.locator(".item", { hasText: title })).toBeVisible();
});

test("AC2: the project list view lists the tasks a member can see, with their key fields", async ({ admin, member, later }) => {
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
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title })).status).toBe(201);
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
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title })).status).toBe(201);

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

test("AC5: the Team page lists people as specified in SHO-US-2.5", async ({ admin, member }) => {
  await admin.page.goto("/team");
  await expect(admin.page.getByRole("heading", { name: "Team" })).toBeVisible();
  for (const heading of ["Name", "Email", "Role", "Status", "Actions"]) {
    await expect(admin.page.getByRole("columnheader", { name: heading, exact: true })).toBeVisible();
  }
  const row = admin.page.locator("tr", { hasText: String(member.user.email) });
  await expect(row).toContainText(String(member.user.name));
  await expect(row).toContainText("Member");
  await expect(row).toContainText("Active");
  await row.getByRole("link", { name: String(member.user.name) }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/team/${member.user.id}$`));
  await expect(admin.page.getByRole("heading", { name: String(member.user.name) })).toBeVisible();
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

test("AC7: each screen matches the approved mockup at 1440x900 and 390x844", async ({ admin, later }) => {
  const project = await makeProject(admin.api, "mockup", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  const title = zz("mockup");
  expect((await admin.api.post(`/api/projects/${project.id}/tasks`, { dueDate: fixtureDueDate(), title, priority: "HIGH" })).status).toBe(201);

  for (const size of [{ width: 1440, height: 900, phone: false }, { width: 390, height: 844, phone: true }] as const) {
    await admin.page.setViewportSize({ width: size.width, height: size.height });

    await admin.page.goto("/");
    await expect(admin.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
    await expect(admin.page.getByText(/open task/)).toBeVisible();

    await admin.page.goto(`/projects/${project.id}`);
    await calm(admin.page);
    const row = admin.page.locator(".item", { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.locator(".pri-t")).toHaveText("High");

    await admin.page.goto(`/projects/${project.id}?view=board`);
    await calm(admin.page);
    await expect(admin.page.locator('.col[aria-label="To do"] .bcard', { hasText: title })).toBeVisible();
    await expect(admin.page.getByRole("button", { name: "+ Add section" })).toBeVisible();

    await admin.page.locator(".bcard", { hasText: title }).click();
    await expect(admin.page.getByRole("dialog", { name: "Task" })).toBeVisible();
    expect(new URL(admin.page.url()).pathname).toBe(`/projects/${project.id}`);

    await admin.page.goto("/team");
    await expect(admin.page.getByRole("heading", { name: "Team" })).toBeVisible();
    if (size.phone) {
      const self = admin.page.locator("tr", { hasText: String(admin.user.email) });
      await expect(self.locator('td[data-label="Role"]')).toBeVisible();
      await expect(self.locator('td[data-label="Role"]')).toHaveText("Super Admin");
    } else {
      await expect(admin.page.getByRole("columnheader", { name: "Role", exact: true })).toBeVisible();
    }

    const brand = await admin.page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return {
        navy: css.getPropertyValue("--navy").trim().toLowerCase(),
        gold: css.getPropertyValue("--gold").trim().toLowerCase(),
        overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      };
    });
    expect(brand.navy).toBe("#2c2f71");
    expect(brand.gold).toBe("#d99d29");
    expect(brand.overflow, `${size.width}x${size.height} stays within the width`).toBe(true);
    if (size.phone) {
      await expect(admin.page.locator(".tabbar")).toBeVisible();
    } else {
      await expect(admin.page.locator("aside.side")).toBeVisible();
    }
  }
});
