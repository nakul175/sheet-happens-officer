// SHO-US-22.7 Task panel as a full-screen sheet (APL-2555). Epic SHO-E22.
// Runs against staging. Data: a ZZ-TEST project with ZZ-TEST tasks, archived afterwards. AC7 needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS.
// Skipped (needs a real iPhone, as the story says): AC3 on-device.
// AC5 (APL-2738) runs in desktop Chromium with a stand-in visualViewport that behaves like iOS Safari's keyboard.
import { test, expect, zz, login, BASE_URL } from "../support";
import { why } from "../helpers/jim-http";
import type { Browser } from "@playwright/test";

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | "member" = "admin") {
  const email = who === "admin" ? login("ADMIN").email : login("MEMBER").email;
  const password = who === "admin" ? login("ADMIN").password : login("MEMBER").password;
  const ctx = await browser.newContext({
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

test.skip("AC3 (on a device): with Safari's toolbar visible the sheet's bottom edge is visible", why(
  "Needs a real iPhone with Safari's toolbar. Desktop Chromium has no dynamic toolbar. The dvh rule is the stylesheet test above.",
), () => {});

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

// APL-2738. Desktop Chromium has no on-screen keyboard, so the page gets a visualViewport that behaves like iOS Safari's:
// the layout viewport keeps its height and only visualViewport shrinks. window.__keyboard(h) opens the "keyboard".
function fakeKeyboard() {
  const vv = new EventTarget() as EventTarget & Record<string, number>;
  let h: number | null = null;
  const props: Record<string, () => number> = {
    height: () => h ?? window.innerHeight, width: () => window.innerWidth, offsetTop: () => 0, offsetLeft: () => 0,
    pageTop: () => window.scrollY, pageLeft: () => window.scrollX, scale: () => 1,
  };
  for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  (window as unknown as { __keyboard: (height: number | null) => void }).__keyboard = (height) => {
    h = height;
    vv.dispatchEvent(new Event("resize"));
  };
}

test("qa:TC missing AC5: with the keyboard open and the description focused, the field and footer are visible", async ({ browser }) => {
  const KEYBOARD_TOP = 420; // visible height left above the keyboard on a 390 x 800 phone
  const ctx = await phone(browser, 390, 800);
  await ctx.addInitScript(fakeKeyboard);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
  const desc = page.locator("#desc");
  await expect(desc).toBeEditable();
  // Type only once the sheet has finished loading: wait until the fields above the description stop moving.
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => {
    const w = window as unknown as { __last?: number; __same?: number };
    const y = document.querySelector<HTMLElement>("#desc")!.offsetTop;
    w.__same = w.__last === y ? (w.__same ?? 0) + 1 : 0;
    w.__last = y;
    return w.__same >= 5;
  }, undefined, { timeout: 15000, polling: 100 });
  await desc.focus();
  await page.evaluate((h) => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(h), KEYBOARD_TOP);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const m = await page.evaluate(() => {
    const box = (el: Element | null) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
    const dialog = document.querySelector('[role="dialog"][aria-label="Task"]')!;
    const close = [...dialog.querySelectorAll(".bar button")].find((b) => b.textContent?.trim() === "Close") ?? null;
    const foot = dialog.querySelector(".sheet-foot");
    return {
      focused: document.activeElement?.id ?? "", sheet: box(dialog.closest(".scrim")), bar: box(dialog.querySelector(".bar")),
      desc: box(document.querySelector("#desc")), close: box(close), foot: box(foot),
      footButtons: foot ? [...foot.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "") : [],
    };
  });
  expect(m.focused, "the description keeps focus").toBe("desc");
  // The sheet follows visualViewport: it ends where the keyboard starts.
  expect(m.sheet!.bottom, "sheet bottom edge").toBeLessThanOrEqual(KEYBOARD_TOP + 1);
  // The footer (Save / Close actions) is there and pinned at the bottom of the visible area.
  expect(m.foot, "the sheet has a footer").not.toBeNull();
  expect(m.footButtons.length, "the footer holds the task actions").toBeGreaterThan(0);
  expect(m.foot!.top, "footer top").toBeGreaterThanOrEqual(-1);
  expect(m.foot!.bottom, "footer bottom").toBeLessThanOrEqual(KEYBOARD_TOP + 1);
  expect(m.foot!.bottom, "footer pinned to the keyboard edge").toBeGreaterThanOrEqual(KEYBOARD_TOP - 1);
  // Close stays in view at the top.
  expect(m.close!.top, "Close top").toBeGreaterThanOrEqual(-1);
  expect(m.close!.bottom, "Close bottom").toBeLessThanOrEqual(KEYBOARD_TOP + 1);
  // The focused description sits between the sticky bar and the footer, so nothing covers it.
  expect(m.desc!.top, "description top").toBeGreaterThanOrEqual(m.bar!.bottom - 1);
  expect(m.desc!.bottom, "description bottom").toBeLessThanOrEqual(m.foot!.top + 1);
  await ctx.close();
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
