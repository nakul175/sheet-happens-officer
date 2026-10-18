// SHO-US-22.7 Task panel as a full-screen sheet (APL-2555). Epic SHO-E22.
// Runs against staging. Data: a ZZ-TEST project with ZZ-TEST tasks, archived afterwards. AC7 needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS.
// Skipped (need a real iPhone / keyboard, as the story says): AC3 on-device, AC5.
import { test, expect, zz } from "../support";
import type { Browser } from "@playwright/test";

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | "member" = "admin") {
  const email = who === "admin" ? process.env.SHO_ADMIN_EMAIL! : process.env.SHO_MEMBER_EMAIL!;
  const password = who === "admin" ? process.env.SHO_ADMIN_PASS! : process.env.SHO_MEMBER_PASS!;
  const ctx = await browser.newContext({
    baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
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

test("AC1: scrolling the sheet does not move the page behind, and Close (44 x 44 px) stays visible", async ({ browser }) => {
  const ctx = await phone(browser, 390, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport();
  const b = (await close.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

// Product defect found 18 Oct 2026 (against dbfbab2): for an editor the 300-character blocked reason sits in a 2-row text box
// (scrollHeight 206 px in a 56 px box), so most of it is hidden until you scroll inside the box. The title is fine.
// The story's "After" says reasons are wrapped and AC2 says fully readable. Remove test.fail() once the box grows to fit.
test("AC2: a 150-character title and a 300-character blocked reason are fully readable by wrapping", async ({ browser }) => {
  test.fail(true, "SHO-US-22.7 AC2: blocked-reason box is 2 rows high, text needs scrolling inside it");
  expect(LONGTITLE.length).toBe(150);
  expect(LONGREASON.length).toBe(300);
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${longId}`, { waitUntil: "load" });
  const title = page.locator("textarea.tt");
  await expect(title).toBeVisible({ timeout: 30000 });
  const reason = page.getByLabel("Why is it blocked?");
  await expect(reason).toBeVisible();
  for (const [name, el] of [["title", title], ["blocked reason", reason]] as const) {
    const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
    expect(m.sw, `${name} scrolls sideways`).toBeLessThanOrEqual(m.cw + 1);
    expect(m.sh, `${name} is clipped vertically`).toBeLessThanOrEqual(m.ch + 2);
  }
  const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
  await ctx.close();
});

test("AC3 (stylesheet part): the phone sheet height uses dvh, not 100vh alone", async ({ admin }) => {
  await admin.page.goto(`/projects/${projectId}?task=${taskId}`);
  const hrefs = await admin.page.$$eval('link[rel="stylesheet"]', (l) => l.map((x) => (x as HTMLLinkElement).href));
  const css = (await Promise.all(hrefs.map(async (h) => (await admin.page.request.get(h)).text()))).join("\n");
  // The build may keep both lines or fold them into one; either way a dvh height must be there and no bare 100vh.
  const rules = css.match(/\.modal\s*\{[^}]*min-height:[^}]*\}/g) ?? [];
  expect(rules.some((r) => /min-height:\s*100dvh/.test(r)), "a .modal rule with min-height 100dvh").toBe(true);
  for (const r of rules) if (/100vh/.test(r)) expect(r).toMatch(/100dvh/);
});

test.skip("AC3 (on a device): with Safari's toolbar visible the sheet's bottom edge is visible", () => {
  // Needs a real iPhone with Safari's toolbar; desktop Chromium has no dynamic toolbar. The dvh rule is checked in the test above.
});

test("AC4: Escape closes the sheet and focus returns to the task row", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item.click", { hasText: zz("22.7 task") }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const back = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return !!a && !!a.closest(".item") && a.closest(".item")!.textContent!.includes("22.7 task"); });
  expect(back, "focus is back on the task row").toBe(true);
  await ctx.close();
});

test("AC4: the Back gesture closes the sheet", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  await page.locator(".item.click", { hasText: zz("22.7 task") }).first().locator(".t b").first().click();
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).not.toContain("task=");
  await ctx.close();
});

test.skip("AC5: with the keyboard open and the description focused, the field and footer are visible", () => {
  // Needs a real on-screen keyboard (visualViewport resizes); not reproducible in desktop Chromium.
});

test("AC6: at 600 px and wider the centred dialog is used, with the same scroll lock", async ({ browser }) => {
  const ctx = await phone(browser, 800, 800, false);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  const b = (await dialog.boundingBox())!;
  expect(b.width).toBeLessThan(800); // not full screen
  expect(b.x).toBeGreaterThan(0);    // centred, with room on both sides
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  await ctx.close();
});

test("AC7: a task I cannot edit stays read-only (Viewer)", async ({ browser, admin, member }) => {
  expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const ctx = await phone(browser, 390, 800, true, "member");
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
  await expect(page.locator("textarea.tt")).not.toBeEditable();
  await expect(page.locator("#desc")).not.toBeEditable();
  expect((await member.api.patch(`/api/tasks/${taskId}`, { title: "ZZ-TEST should be refused" })).status).toBeGreaterThanOrEqual(400);
  await ctx.close();
});
