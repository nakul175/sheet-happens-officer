// SHO-US-22.7 Task panel as a full-screen sheet (APL-2555). Epic SHO-E22.
// Runs against staging. Data: a ZZ-TEST project with ZZ-TEST tasks, archived afterwards. AC7 needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS.
// AC3 on-device and AC5 (APL-2738) run in desktop Chromium: AC3 at the height an iPhone shows with Safari's toolbar visible,
// AC5 with a stand-in visualViewport that behaves like iOS Safari's keyboard. A real-iPhone check is still a manual step.
import { test, expect, zz, login, BASE_URL } from "../support";
import type { Browser, BrowserContext } from "@playwright/test";

const phoneContexts: BrowserContext[] = [];

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | "member" = "admin") {
  const email = who === "admin" ? login("ADMIN").email : login("MEMBER").email;
  const password = who === "admin" ? login("ADMIN").password : login("MEMBER").password;
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  phoneContexts.push(ctx);
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `sign in as ${who}`).toBe(true);
  return ctx;
}

const LONGTITLE = ("Title words ".repeat(13)).slice(0, 150);
const LONGREASON = ("Blocked because the supplier has not replied ".repeat(8)).slice(0, 300);
let projectId = "", taskId = "", longId = "";
test.beforeEach(async ({ admin }) => {
  projectId = ""; taskId = ""; longId = "";
  const r = await admin.api.post("/api/projects", { name: zz("22.7 sheet"), leaderId: admin.user.id });
  if (r.status === 201) projectId = r.json.project.id; // Own the resource before any later setup can fail.
  expect(r.status).toBe(201);
  const dueDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const ordinary = await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.7 task"), dueDate, description: "Line of description.\n".repeat(60) });
  expect(ordinary.status, JSON.stringify(ordinary.json)).toBe(201);
  taskId = ordinary.json.task.id;
  const long = await admin.api.post(`/api/projects/${projectId}/tasks`, { title: LONGTITLE, dueDate });
  expect(long.status, JSON.stringify(long.json)).toBe(201);
  longId = long.json.task.id;
  const t = (await admin.api.get(`/api/tasks/${longId}`)).json.task;
  const b = await admin.api.patch(`/api/tasks/${longId}`, { blocked: true, blockedReason: LONGREASON, expectedUpdatedAt: t.updatedAt });
  expect(b.status, JSON.stringify(b.json)).toBe(200);
});

test.afterEach(async ({ admin }) => {
  const closed = await Promise.allSettled(phoneContexts.splice(0).map(context => context.close()));
  const ownedProject = projectId; projectId = "";
  if (ownedProject) {
    const archived = await admin.api.post(`/api/projects/${ownedProject}/archive`);
    expect(archived.status, "run-owned project archive").toBe(200);
    const readback = await admin.api.get(`/api/projects/${ownedProject}`);
    expect(readback.status).toBe(200);
    expect(readback.json.project.archived, "run-owned project is archived").toBe(true);
  }
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

test("qa:TC missing AC1: scrolling the sheet does not move the page behind, and Close (44 x 44 px) stays visible", async ({ browser }) => {
  const ctx = await phone(browser, 390, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  // The scroll lock is set in an effect after the sheet first paints, so wait for it instead of reading it once.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow), { message: "page behind is locked" }).toBe("hidden");
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 900);
  // Wait until scrolling has been quiet for 200 ms (any scroller, so the sheet's own scroll counts too).
  await page.evaluate(() => new Promise<void>((done) => {
    let t = 0;
    const quiet = () => { clearTimeout(t); t = window.setTimeout(() => { removeEventListener("scroll", quiet, true); done(); }, 200); };
    addEventListener("scroll", quiet, true);
    quiet();
  }));
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport();
  const b = (await close.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

// Current UI auto-grows the blocked reason. This is an ordinary required pass, not an expected failure.
test("qa:TC missing AC2: a 150-character title and a 300-character blocked reason are fully readable by wrapping", async ({ browser }) => {
  expect(LONGTITLE.length).toBe(150);
  expect(LONGREASON.length).toBe(300);
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${longId}`, { waitUntil: "load" });
  const title = page.getByRole("dialog", { name: "Task" }).getByRole("textbox", { name: "Title", exact: true });
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

test("qa:TC missing AC3 (stylesheet part): the phone sheet height uses dvh, not 100vh alone", async ({ admin }) => {
  await admin.page.goto(`/projects/${projectId}?task=${taskId}`);
  const hrefs = await admin.page.$$eval('link[rel="stylesheet"]', (l) => l.map((x) => (x as HTMLLinkElement).href));
  const css = (await Promise.all(hrefs.map(async (h) => (await admin.page.request.get(h)).text()))).join("\n");
  // The build may keep both lines or fold them into one; either way a dvh height must be there and no bare 100vh.
  const rules = css.match(/\.modal\s*\{[^}]*min-height:[^}]*\}/g) ?? [];
  expect(rules.some((r) => /min-height:\s*100dvh/.test(r)), "a .modal rule with min-height 100dvh").toBe(true);
  for (const r of rules) if (/100vh/.test(r)) expect(r).toMatch(/100dvh/);
});

// With Safari's toolbars showing, an iPhone 13 (390 x 844) leaves about 390 x 664 for the page. Desktop Chromium has no
// dynamic toolbar, so the page is opened at that visible size: scrolled to its end, the sheet must fill it and end inside it.
// The test above checks the dvh rule that makes Safari size the sheet to this visible height rather than the toolbar-less one.
test("qa:TC missing AC3 (Chromium viewport emulation): the toolbar-sized sheet's bottom edge is visible", async ({ browser }) => {
  const VISIBLE = { width: 390, height: 664 };
  const ctx = await phone(browser, VISIBLE.width, VISIBLE.height);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  const last = dialog.getByRole("button", { name: "Move to Trash" });
  await expect(last).toBeVisible();
  // Scroll the sheet to its end.
  await page.mouse.move(VISIBLE.width / 2, VISIBLE.height / 2);
  await expect.poll(async () => {
    await page.mouse.wheel(0, 2000);
    return (await dialog.boundingBox())!.y + (await dialog.boundingBox())!.height;
  }, { message: "sheet bottom edge after scrolling to the end" }).toBeLessThanOrEqual(VISIBLE.height + 1);
  const b = (await dialog.boundingBox())!;
  expect(b.y + b.height, "the sheet reaches the bottom of the visible area").toBeGreaterThanOrEqual(VISIBLE.height - 1);
  await expect(last, "the last control on the sheet can be reached").toBeInViewport();
  await ctx.close();
});

test("qa:TC missing AC4: Escape closes the sheet and focus returns to the task row", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.getByRole("link", { name: zz("22.7 task") }); // task rows are role="link"
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

test("qa:TC missing AC4: the Back gesture closes the sheet", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  await page.getByRole("link", { name: zz("22.7 task") }).getByText(zz("22.7 task"), { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).not.toContain("task=");
  await ctx.close();
});

// APL-2738. Desktop Chromium has no on-screen keyboard, so the page gets a visualViewport that behaves like iOS Safari's:
// the layout viewport keeps its height and only visualViewport shrinks, and may move down the page (offsetTop) as iOS does.
// window.__keyboard(h, top) opens the "keyboard".
function fakeKeyboard() {
  const vv = new EventTarget() as EventTarget & Record<string, number>;
  let h: number | null = null, top = 0;
  const props: Record<string, () => number> = {
    height: () => h ?? window.innerHeight, width: () => window.innerWidth, offsetTop: () => top, offsetLeft: () => 0,
    pageTop: () => window.scrollY + top, pageLeft: () => window.scrollX, scale: () => 1,
  };
  for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  (window as unknown as { __keyboard: (height: number | null, offsetTop?: number) => void }).__keyboard = (height, offsetTop = 0) => {
    h = height;
    top = offsetTop;
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
  };
}

test("qa:TC-APL2738-05@v1 AC5: with the keyboard open and the description focused, the field and footer are visible", async ({ browser }) => {
  const KEYBOARD_TOP = 420; // visible height left above the keyboard on a 390 x 800 phone
  const ctx = await phone(browser, 390, 800);
  await ctx.addInitScript(fakeKeyboard);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  const desc = dialog.getByLabel("Description", { exact: true });
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const action = dialog.getByRole("button", { name: /^(Mark complete|Close task)$/ }); // the footer's main action
  await expect(desc).toBeEditable();
  await expect(action).toBeVisible();
  // Type only once the sheet has finished loading: wait until the fields above the description stop moving.
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => {
    const w = window as unknown as { __last?: number; __same?: number };
    const y = document.getElementById("desc")!.getBoundingClientRect().top;
    w.__same = w.__last === y ? (w.__same ?? 0) + 1 : 0;
    w.__last = y;
    return w.__same >= 5;
  }, undefined, { timeout: 15000, polling: 100 });
  await desc.focus();
  const keyboard = async (h: number, offsetTop: number) => {
    await page.evaluate(([kh, kt]) => (window as unknown as { __keyboard: (h: number, t: number) => void }).__keyboard(kh, kt), [h, offsetTop] as const);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  await keyboard(KEYBOARD_TOP, 0);
  await expect(desc, "the description keeps focus").toBeFocused();
  const d = (await desc.boundingBox())!, c = (await close.boundingBox())!, a = (await action.boundingBox())!;
  // Close stays in view at the top of the visible area.
  expect(c.y, "Close top").toBeGreaterThanOrEqual(-1);
  expect(c.y + c.height, "Close bottom").toBeLessThanOrEqual(KEYBOARD_TOP + 1);
  // The footer action is pinned just above the keyboard: the sheet follows visualViewport.
  expect(a.y + a.height, "footer action is above the keyboard").toBeLessThanOrEqual(KEYBOARD_TOP + 1);
  expect(a.y + a.height, "footer action is pinned to the keyboard edge").toBeGreaterThanOrEqual(KEYBOARD_TOP - 24);
  // The focused description sits between Close and the footer, so nothing covers it.
  expect(d.y, "description top").toBeGreaterThanOrEqual(c.y + c.height - 1);
  expect(d.y + d.height, "description bottom").toBeLessThanOrEqual(a.y + 1);
  // iOS can also move the visible area down the page (visualViewport.offsetTop): the sheet must move with it.
  const MOVED = 60, MOVED_HEIGHT = 380;
  await keyboard(MOVED_HEIGHT, MOVED);
  await expect(desc, "the description keeps focus after the move").toBeFocused();
  const d2 = (await desc.boundingBox())!, c2 = (await close.boundingBox())!, a2 = (await action.boundingBox())!;
  expect(c2.y, "Close moves down with the visible area").toBeGreaterThanOrEqual(MOVED - 1);
  expect(a2.y + a2.height, "footer action stays above the keyboard").toBeLessThanOrEqual(MOVED + MOVED_HEIGHT + 1);
  expect(a2.y + a2.height, "footer action stays pinned to the keyboard edge").toBeGreaterThanOrEqual(MOVED + MOVED_HEIGHT - 24);
  expect(d2.y, "description top after the move").toBeGreaterThanOrEqual(c2.y + c2.height - 1);
  expect(d2.y + d2.height, "description bottom after the move").toBeLessThanOrEqual(a2.y + 1);
  await ctx.close();
});

test("qa:TC missing AC6: at 600 px and wider the centred dialog is used, with the same scroll lock", async ({ browser }) => {
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

test("qa:TC missing AC7: a task I cannot edit stays read-only (Viewer)", async ({ browser, admin, member }) => {
  expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const ctx = await phone(browser, 390, 800, true, "member");
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
  const sheet = page.getByRole("dialog", { name: "Task" });
  await expect(sheet.getByRole("textbox", { name: "Title", exact: true })).not.toBeEditable();
  await expect(sheet.getByLabel("Description", { exact: true })).not.toBeEditable();
  expect((await member.api.patch(`/api/tasks/${taskId}`, { title: "ZZ-TEST should be refused" })).status).toBeGreaterThanOrEqual(400);
  await ctx.close();
});
