import { archiveProject, removeMember } from "../helpers/migration-2731";
import { test } from "./qa";
// APL-2501 · SHO-US-5.6 Branded app shell that works on a phone
// Acceptance criteria: AC1 1280 px layout with a 340 px concierge slot, AC2 390 px phone layout, AC3 brand mark and Public Sans,
// AC4 sidebar by role, AC5 notification bell.
// Notes on AC text that later stories changed (the tests follow the live behaviour and say so):
//  - AC4 lists only My tasks, Projects and Team; CRM stories later added Deals and Accounts, so the test checks the role-specific items only.
//  - AC5 says opening the bell marks the list read and shows the latest 30; SHO-US-14.13 changed it: nothing is marked read until
//    the person clicks a notice, and the panel shows up to 50. The test checks the 14.13 behaviour.
// Data: every project and task is named "ZZ-TEST ...".
import { expect, zz, type Who } from "../support";

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id));
  return id;
}

test("AC1: at 1280 px the approved desktop header and full content width render on list screens", async ({ admin, later }) => {
  const p = await proj(admin, "shell-wide", later);
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await admin.page.goto("/my-tasks");
  // The approved header switches to its drawer below1440px.
  await admin.page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(admin.page.locator("aside[aria-label='Main'] nav.nav")).toBeVisible();
  await admin.page.keyboard.press("Escape");
  await expect(admin.page.locator("aside[aria-label='Main']")).toBeHidden();
  await expect(admin.page.locator("main.content, main#main").first()).toBeVisible();
  for (const path of ["/my-tasks", `/projects/${p}`]) {
    await admin.page.goto(path);
    const content = admin.page.locator("main#main");
    await expect(content).toBeVisible();
    expect((await content.boundingBox())!.width).toBeGreaterThan(1000);
    await expect(admin.page.locator(".with-dock,.with-bar,.cc-barslot,.cc-fabwrap")).toHaveCount(0);
  }
});

test("AC2: at 390 px the sidebar collapses and no page scrolls sideways", async ({ admin, later }) => {
  const p = await proj(admin, "shell-phone", later);
  await admin.page.setViewportSize({ width: 390, height: 800 });
  for (const path of ["/", "/projects", `/projects/${p}`, "/team"]) {
    await admin.page.goto(path);
    await expect(admin.page.locator("main").first()).toBeVisible();
    await expect(admin.page.locator("aside.side, aside[aria-label='Main']").first()).toBeHidden();
    const fits = await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(fits, `${path} scrolls sideways at 390 px`).toBe(true);
  }
});

test("AC3: the icon-only mark shows at 24 px and the text uses Public Sans", async ({ admin }) => {
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await admin.page.goto("/");
  const img = admin.page.locator(".top-brand img");
  await expect(img).toHaveAttribute("src", "/logo-icon-reversed.svg");
  const box = (await img.boundingBox())!;
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(24);
  expect(Math.round(box.width)).toBeLessThanOrEqual(36);
  const svg = await admin.page.request.get("/logo-icon-reversed.svg");
  expect(svg.status()).toBe(200);
  const font = await admin.page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(font).toMatch(/Public\s*Sans/i);
});

test("AC4: Audit log is for the Super Admin only; retired Usage is not in the navigation", async ({ admin, member }) => {
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await member.page.setViewportSize({ width: 1280, height: 800 });
  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: /^Account and utilities, \S+$/ }).click();
  const adminNav = admin.page.locator("#account-utilities");
  await expect(adminNav.getByRole("link", { name: "Usage" })).toHaveCount(0);
  await expect(adminNav.getByRole("link", { name: "Audit log" })).toBeVisible();
  await member.page.goto("/");
  await member.page.getByRole("button", { name: "Open menu", exact: true }).click();
  const memberNav = member.page.locator("aside[aria-label='Main'] nav.nav");
  for (const l of ["My tasks", "Projects", "Team"]) await expect(memberNav.getByRole("link", { name: l, exact: true })).toBeVisible();
  await member.page.keyboard.press("Escape");
  await member.page.getByRole("button", { name: /^Account and utilities, \S+$/ }).click();
  await expect(member.page.locator("#account-utilities").getByRole("link", { name: "Usage" })).toHaveCount(0);
  await expect(member.page.locator("#account-utilities").getByRole("link", { name: "Audit log" })).toHaveCount(0);
  for (const path of ["/audit"]) {
    await member.page.goto(path);
    await expect(member.page.getByText("This page isn't available").first()).toBeVisible();
  }
  expect((await member.api.get("/api/audit")).status).toBe(404);
});

test("AC5: the bell shows the unread count, lists notices newest first with links, and shows no count when there are none", async ({ admin, member, later }) => {
  const p = await proj(admin, "shell-bell", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => removeMember(admin, p, member.user.id));
  await member.api.post("/api/notifications/read-all");
  await member.page.goto("/");
  await expect(member.page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible(); // none: no count in the name
  expect((await admin.api.post(`/api/projects/${p}/tasks`, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), title: zz("first notice"), assigneeId: member.user.id })).status).toBe(201);
  const t2 = (await admin.api.post(`/api/projects/${p}/tasks`, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), title: zz("second notice"), assigneeId: member.user.id })).json.task.id;
  await member.page.reload();
  const bell = member.page.getByRole("button", { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toBeVisible();
  const count = Number((await bell.getAttribute("aria-label"))!.match(/(\d+) unread/)![1]);
  expect(count).toBeGreaterThanOrEqual(2);
  await bell.click();
  const panel = member.page.getByRole("dialog", { name: "Notifications" });
  const rows = panel.locator(".bell-main");
  await expect(rows.first()).toContainText(zz("second notice")); // newest first
  await expect(rows.nth(1)).toContainText(zz("first notice"));
  await expect(rows.first()).toHaveAttribute("href", new RegExp(`/tasks/${t2}`));
  // SHO-US-14.13: opening the panel marks nothing read; clicking a notice does
  expect((await member.api.get("/api/notifications")).json.unread).toBe(count);
  await rows.first().click();
  await expect.poll(async () => (await member.api.get("/api/notifications")).json.unread).toBe(count - 1);
});
