// SHO-US-22.7 Task panel as a full-screen sheet (APL-2555). Epic SHO-E22. Migrated from origin/qa/story-e2e by SHO-2905.
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing: an AC number is not a TC id.
// Local only: TASKBOARD_URL must be a server on this machine with a test database; any other host, production included, is refused.
// Data: a ZZ-TEST project with ZZ-TEST tasks and a ZZ-TEST Viewer, archived and deactivated afterwards. AC3 checks the dvh
// rule and the sheet's bottom edge. AC5 shortens the viewport to stand in for the keyboard.
// Playwright (APL-2761, APL-2911): playwright.config.ts collects tests/e2e/stories/*.spec.ts. The API calls go through
// ../local-api, which has no vitest import, so Playwright can load this file.
import { devices, expect, test, type Browser } from "@playwright/test";
import { account, BASE, patchTask, PW, SUPER_EMAIL, superAdmin, task, type Account } from "../local-api";
import { clickClear, linkHrefs, scrollClear } from "../helpers/locate";

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const zz = (label: string) => `ZZ-TEST ${label} ${RUN}`;

const LONGTITLE = ("Title words ".repeat(13)).slice(0, 150);
const LONGREASON = ("Blocked because the supplier has not replied ".repeat(8)).slice(0, 300);

let browser: Browser;
let root: Account;
let viewer: Account | undefined;
let projectId = "";
let taskId = "";
let longId = "";

test.beforeAll(async ({ browser: b }) => {
  test.setTimeout(180000);
  browser = b;
  root = await superAdmin();
  viewer = await account(zz("viewer"), `nakul17+zz-2555-${RUN}-viewer@aplyd.com`);
  const p = await root.c.post("/api/projects", { name: zz("22.7 sheet"), leaderId: root.id });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.project.id as string;
  expect((await root.c.post(`/api/projects/${projectId}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  taskId = await task(root, projectId, { title: zz("22.7 task"), dueDate: "2031-03-20", description: "Line of description.\n".repeat(60) });
  longId = await task(root, projectId, { title: LONGTITLE, dueDate: "2031-03-20" });
  const b2 = await patchTask(root, longId, { blocked: true, blockedReason: LONGREASON });
  expect(b2.status, JSON.stringify(b2.json)).toBe(200);
});

test.afterAll(async () => {
  if (root && projectId) expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
  if (root && viewer) {
    const off = await root.c.post(`/api/team/${viewer.id}/deactivate`, { reassign: "leaders" });
    expect(off.status === 200 || (off.status === 409 && /already deactivated/.test(off.json?.error ?? "")), JSON.stringify(off.json)).toBe(true);
  }
});

async function phone(width: number, height = 800, touch = true, who: { email: string; password: string } = { email: SUPER_EMAIL, password: PW }, device: (typeof devices)["Pixel 5"] = devices["Pixel 5"]) {
  const ctx = await browser.newContext({ ...device, baseURL: BASE, viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: who.password } });
  expect(r.ok(), `sign in as ${who.email}`).toBe(true);
  return ctx;
}

test.describe("qa:TC missing APL-2555 the task panel is a full-screen sheet on a phone", () => {
  // qa:TC missing
  test("AC1: scrolling the sheet does not move the page behind, and Close (44 x 44 px) stays visible qa:TC missing", async () => {
    const ctx = await phone(390, 700);
    const page = await ctx.newPage();
    try {
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
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC2: a 150-character title and a 300-character blocked reason are fully readable by wrapping qa:TC missing", async () => {
    expect(LONGTITLE.length).toBe(150);
    expect(LONGREASON.length).toBe(300);
    const ctx = await phone(320, 700);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${longId}`, { waitUntil: "load" });
      const title = page.getByRole("dialog", { name: "Task" }).getByLabel("Title");
      await scrollClear(title);
      await expect(title).toBeVisible({ timeout: 30000 });
      const reason = page.getByLabel("Why is it blocked?");
      await expect(reason).toBeVisible();
      for (const [name, el] of [["title", title], ["blocked reason", reason]] as const) {
        const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
        expect(m.sw, `${name} scrolls sideways`).toBeLessThanOrEqual(m.cw + 1);
        // APL-2709 defect (Linear APL-2709): the blocked-reason box grows to five lines, then scrolls inside itself.
        expect(m.sh, `APL-2709 APL-2555 defect: the ${name} is clipped vertically (scrollHeight ${m.sh}, clientHeight ${m.ch})`).toBeLessThanOrEqual(m.ch + 2);
      }
      const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC3 (stylesheet part): the phone sheet height uses dvh, not 100vh alone qa:TC missing", async () => {
    const ctx = await phone(390, 800);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const hrefs = await linkHrefs(page, "stylesheet");
      const css = (await Promise.all(hrefs.map(async (h) => (await page.request.get(h)).text()))).join("\n");
      // The build may keep both lines or fold them into one; either way a dvh height must be there and no bare 100vh.
      const rules = css.match(/\.modal\s*\{[^}]*min-height:[^}]*\}/g) ?? [];
      expect(rules.some((r) => /min-height:\s*100dvh/.test(r)), "a .modal rule with min-height 100dvh").toBe(true);
      for (const r of rules) if (/100vh/.test(r)) expect(r).toMatch(/100dvh/);
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC3 (Chromium proxy, needs a device): with an iPhone-sized viewport shortened for Safari's toolbar, the sheet's bottom edge is visible qa:TC missing", async () => {
    const ctx = await phone(390, 664, true, { email: SUPER_EMAIL, password: PW }, devices["iPhone 13"]);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const dialog = page.getByRole("dialog", { name: "Task" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Title")).toBeEditable();
      const fit = await dialog.evaluate((el) => {
        const vv = window.visualViewport?.height ?? window.innerHeight;
        return { height: el.getBoundingClientRect().height, vv };
      });
      expect(Math.abs(fit.height - fit.vv)).toBeLessThanOrEqual(2);
      await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
    } finally { await ctx.close(); }
  });


  // qa:TC missing
  test("AC4: Escape closes the sheet and focus returns to the task row qa:TC missing", async () => {
    const ctx = await phone(390, 800);
    const page = await ctx.newPage();
    try {
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
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC4: the Back gesture closes the sheet qa:TC missing", async () => {
    const ctx = await phone(390, 800);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
      const row = page.getByRole("link", { name: zz("22.7 task") });
      await clickClear(row.getByText(zz("22.7 task"), { exact: true }));
      const dialog = page.getByRole("dialog", { name: "Task" });
      await expect(dialog).toBeVisible();
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      expect(page.url()).not.toContain("task=");
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC5: with the keyboard open and the description focused, the field and footer are visible qa:TC missing", async () => {
    const ctx = await phone(390, 844);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const dialog = page.getByRole("dialog", { name: "Task" });
      await expect(dialog).toBeVisible();
      const desc = dialog.getByLabel("Description");
      await scrollClear(desc);
      await desc.focus();
      await page.setViewportSize({ width: 390, height: 380 });
      const kept = () => desc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const h = window.visualViewport?.height ?? window.innerHeight;
        return r.height > 0 && r.top >= 0 && r.bottom <= h + 1;
      });
      // APL-2709 defect (Linear APL-2709): the sheet does not follow visualViewport, and the footer is not pinned in that area.
      await expect.poll(kept, { message: "APL-2709 APL-2555 defect: with the visible area shortened to 380 px (the keyboard), the focused description is outside it" }).toBe(true);
      await expect(desc).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Mark complete" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Move to Trash" })).toBeInViewport();
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC6: at 600 px and wider the centred dialog is used, with the same scroll lock qa:TC missing", async () => {
    const ctx = await phone(800, 800, false);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const dialog = page.getByRole("dialog", { name: "Task" });
      await expect(dialog).toBeVisible({ timeout: 30000 });
      const b = (await dialog.boundingBox())!;
      expect(b.width).toBeLessThan(800); // not full screen
      expect(b.x).toBeGreaterThan(0); // centred, with room on both sides
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    } finally { await ctx.close(); }
  });

  // qa:TC missing
  test("AC7: a task I cannot edit stays read-only (Viewer) qa:TC missing", async () => {
    expect(viewer, "the ZZ-TEST viewer exists").toBeTruthy();
    const ctx = await phone(390, 800, true, { email: viewer!.email, password: PW });
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
      const sheet = page.getByRole("dialog", { name: "Task" });
      await expect(sheet.getByLabel("Title")).not.toBeEditable();
      await expect(sheet.getByLabel("Description")).not.toBeEditable();
      expect((await patchTask(viewer!, taskId, { title: "ZZ-TEST should be refused" })).status).toBeGreaterThanOrEqual(400);
    } finally { await ctx.close(); }
  });
});
