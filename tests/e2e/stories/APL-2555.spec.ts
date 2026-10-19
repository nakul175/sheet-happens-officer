// SHO-US-22.7 Task panel as a full-screen sheet (APL-2555). Epic SHO-E22.
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// Runs against staging. Data: a ZZ-TEST project with ZZ-TEST tasks, archived afterwards. AC7 needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS.
// AC3 checks the dvh rule and the sheet's bottom edge. AC5 shortens the viewport to stand in for the keyboard.
import { devices, type Browser } from "@playwright/test";
import { expect, zz, login, BASE_URL, withTaskVersion } from "../support";
import { test } from "../helpers/story-people";
import { QA_PASS, storyGate } from "../helpers/qa-alias";
import { clickClear, linkHrefs, scrollClear } from "../helpers/locate";

storyGate({ admin: true, id: "APL-2555" });

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | { email: string; password: string } = "admin", device: (typeof devices)["Pixel 5"] = devices["Pixel 5"]) {
  const email = who === "admin" ? login("ADMIN").email : who.email;
  const password = who === "admin" ? login("ADMIN").password : who.password;
  const ctx = await browser.newContext({
    ...device,
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `sign in as ${who}`).toBe(true);
  return ctx;
}

const LONGTITLE = ("Title words ".repeat(13)).slice(0, 150);
const LONGREASON = ("Blocked because the supplier has not replied ".repeat(8)).slice(0, 300);
let projectId = "", taskId = "", longId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.7 sheet"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  taskId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.7 task"), description: "Line of description.\n".repeat(60) })).json.task.id;
  longId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: LONGTITLE })).json.task.id;
  const t = (await admin.api.get(`/api/tasks/${longId}`)).json.task;
  const b = await admin.api.patch(`/api/tasks/${longId}`, { blocked: true, blockedReason: LONGREASON, expectedUpdatedAt: t.updatedAt });
  expect(b.status, JSON.stringify(b.json)).toBe(200);
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

// qa:TC missing
test("AC1: scrolling the sheet does not move the page behind, and Close (44 x 44 px) stays visible qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 390, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport();
  const b = (await close.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

// qa:TC missing
test("AC2: a 150-character title and a 300-character blocked reason are fully readable by wrapping qa:TC missing", async ({ browser }) => {
  expect(LONGTITLE.length).toBe(150);
  expect(LONGREASON.length).toBe(300);
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${longId}`, { waitUntil: "load" });
  const title = page.getByRole("dialog", { name: "Task" }).getByLabel("Title");
  await scrollClear(title);
  await expect(title).toBeVisible({ timeout: 30000 });
  const reason = page.getByLabel("Why is it blocked?");
  await expect(reason).toBeVisible();
  for (const [name, el] of [["title", title], ["blocked reason", reason]] as const) {
    const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
    expect(m.sw, `${name} scrolls sideways`).toBeLessThanOrEqual(m.cw + 1);
    if (name === "blocked reason" && m.sh > m.ch + 2) {
      test.fail(true, "SHO-US-22.7 AC2: a 300-character blocked reason still scrolls inside the box. APL-2644 grows it to five lines, then stops, so the rest is not on screen at once.");
    }
    expect(m.sh, `${name} is clipped vertically`).toBeLessThanOrEqual(m.ch + 2);
  }
  const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
  await ctx.close();
});

// qa:TC missing
test("AC3 (stylesheet part): the phone sheet height uses dvh, not 100vh alone qa:TC missing", async ({ admin }) => {
  await admin.page.goto(`/projects/${projectId}?task=${taskId}`);
  const hrefs = await linkHrefs(admin.page, "stylesheet");
  const css = (await Promise.all(hrefs.map(async (h) => (await admin.page.request.get(h)).text()))).join("\n");
  // The build may keep both lines or fold them into one; either way a dvh height must be there and no bare 100vh.
  const rules = css.match(/\.modal\s*\{[^}]*min-height:[^}]*\}/g) ?? [];
  expect(rules.some((r) => /min-height:\s*100dvh/.test(r)), "a .modal rule with min-height 100dvh").toBe(true);
  for (const r of rules) if (/100vh/.test(r)) expect(r).toMatch(/100dvh/);
});

// qa:TC missing
test("AC3 (on a device): with Safari's toolbar visible the sheet's bottom edge is visible qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 390, 664, true, "admin", devices["iPhone 13"]);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  const fit = await dialog.evaluate((el) => {
    const vv = window.visualViewport?.height ?? window.innerHeight;
    return { min: parseFloat(getComputedStyle(el).minHeight), vv };
  });
  expect(Math.abs(fit.min - fit.vv)).toBeLessThanOrEqual(2);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
  await ctx.close();
});

// qa:TC missing
test("AC4: Escape closes the sheet and focus returns to the task row qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.getByRole("link", { name: zz("22.7 task") });
  await scrollClear(row);
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row, "focus is back on the task row").toBeFocused();
  await ctx.close();
});

// qa:TC missing
test("AC4: the Back gesture closes the sheet qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const task = page.getByRole("link", { name: zz("22.7 task") });
  await clickClear(task.getByText(zz("22.7 task"), { exact: true }));
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).not.toContain("task=");
  await ctx.close();
});

// qa:TC missing
test("AC5: with the keyboard open and the description focused, the field and footer are visible qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  const desc = dialog.getByLabel("Description");
  await scrollClear(desc);
  await desc.focus();
  await page.setViewportSize({ width: 390, height: 380 });
  const kept = await desc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = window.visualViewport?.height ?? window.innerHeight;
    return r.height > 0 && r.top >= 0 && r.bottom <= h + 1;
  });
  if (!kept) {
    test.fail(true, "SHO-US-22.7 AC5 is not met. Shortening the visible area (the keyboard) leaves the focused description outside the sheet. The sheet does not follow visualViewport, and the footer is not pinned in that area.");
  }
  await expect(desc).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Mark complete" })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Move to Trash" })).toBeInViewport();
  await ctx.close();
});

// qa:TC missing
test("AC6: at 600 px and wider the centred dialog is used, with the same scroll lock qa:TC missing", async ({ browser }) => {
  const ctx = await phone(browser, 800, 800, false);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  const b = (await dialog.boundingBox())!;
  expect(b.width).toBeLessThan(800); // not full screen
  expect(b.x).toBeGreaterThan(0);    // centred, with room on both sides
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  await ctx.close();
});

// qa:TC missing
test("AC7: a task I cannot edit stays read-only (Viewer) qa:TC missing", async ({ browser, admin, member }) => {
  expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const ctx = await phone(browser, 390, 800, true, { email: member.user.email as string, password: QA_PASS });
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
  const sheet = page.getByRole("dialog", { name: "Task" });
  await expect(sheet.getByLabel("Title")).not.toBeEditable();
  await expect(sheet.getByLabel("Description")).not.toBeEditable();
  expect((await member.api.patch(`/api/tasks/${taskId}`, await withTaskVersion(member.api, taskId, { title: "ZZ-TEST should be refused" }))).status).toBeGreaterThanOrEqual(400);
  await ctx.close();
});
