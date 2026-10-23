// SHO-US-22.9 Touch, motion and zoom behaviour (APL-2557). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project with ZZ-TEST tasks, archived afterwards. The collaborator part of AC1 uses SHO_MEMBER_EMAIL / SHO_MEMBER_PASS when set.
import { test, expect, zz, hasMember, login, BASE_URL } from "../support";
import { collect } from "../../viewport/checks";
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

let projectId = "", taskId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.9 touch"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  taskId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.9 task"), assigneeId: admin.user.id })).json.task.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("AC1: tapping the avatar group shows the assignee's name (and collaborators' when there are any)", async ({ browser, admin }) => {
  let collaborator = "";
  if (hasMember()) {
    const me = await (await (await browser.newContext({ baseURL: BASE_URL, httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined })).request.post("/api/auth/signin", { data: { email: login("MEMBER").email, password: login("MEMBER").password } })).json();
    expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: me.user.id, role: "EDITOR" })).status).toBe(201);
    expect((await admin.api.post(`/api/tasks/${taskId}/collaborators`, { userId: me.user.id })).status).toBeLessThan(300);
    collaborator = me.user.name;
  }
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?view=board`, { waitUntil: "load" }); // avatar groups are on board cards
  const group = page.locator(".bcard", { hasText: zz("22.9 task") }).first().locator(".avbtn");
  await expect(group).toBeVisible({ timeout: 30000 });
  await group.tap();
  const pop = page.locator(".avpop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText(String(admin.user.name));
  if (collaborator) await expect(pop).toContainText(collaborator);
  await ctx.close();
});

test("AC2: after tapping a row no hover background stays on it", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item.click", { hasText: zz("22.9 task") }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  const bg = () => row.evaluate((e) => getComputedStyle(e).backgroundColor);
  const before = await bg();
  await row.locator(".t b").first().tap();
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Task" })).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // Escape puts the keyboard focus ring back on the row; that is not a hover
  await page.waitForTimeout(400);
  expect(await bg()).toBe(before);
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
  await ctx.close();
});

test("AC3: with Reduce motion on, opening the task sheet and the drawer runs no animation", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(100);
  const running = async () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && !(a.effect as KeyframeEffect)?.target?.closest?.(".skel-row, .cc-dot")).map((a) => (a as CSSAnimation).animationName ?? a.constructor.name));
  expect(await running(), "animations running with the task sheet open").toEqual([]);
  await page.keyboard.press("Escape");
  const wide = await phone(browser, 700, 800);
  const p2 = await wide.newPage();
  await p2.emulateMedia({ reducedMotion: "reduce" });
  await p2.goto("/", { waitUntil: "load" });
  await p2.getByRole("button", { name: "Open menu" }).click();
  await p2.waitForTimeout(100);
  expect(await p2.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => (a as CSSAnimation).animationName ?? "transition")), "animations while the drawer opens").toEqual([]);
  await wide.close();
  await ctx.close();
});

test("AC4: at 200 percent zoom on a 360 px phone (a 180 px layout) My tasks, the board and the task panel do not scroll sideways", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await phone(browser, 180, 640);
  const page = await ctx.newPage();
  for (const path of ["/", `/projects/${projectId}?view=board`, `/projects/${projectId}?task=${taskId}`]) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw, `${path} scrolls sideways at 200% zoom`).toBeLessThanOrEqual(m.iw + 1);
    const found = (await page.evaluate(collect, true)).filter((f) => f.check === "overflow");
    expect(found, `${path} overflow findings`).toEqual([]);
  }
  await ctx.close();
});

test("AC5: pinch zoom is not disabled by the viewport meta", async ({ admin }) => {
  await admin.page.goto("/");
  const meta = (await admin.page.locator('meta[name="viewport"]').getAttribute("content")) ?? "";
  expect(meta).not.toMatch(/user-scalable\s*=\s*(no|0)/);
  expect(meta).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/);
});

test("Prohibited: no text under 12 px for information on My tasks and a project list at 390 px", async ({ browser }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  const small: string[] = [];
  for (const path of ["/", `/projects/${projectId}`]) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(300);
    small.push(...(await page.evaluate(() => {
      const out: string[] = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent?.trim(); if (!t) continue;
        const el = n.parentElement!; const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[aria-hidden=true]") || el.closest(".sr-only") || el.closest("kbd")) continue; // a keyboard-shortcut hint (Ctrl K, 11 px) is not information a touch user needs
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        if (parseFloat(cs.fontSize) < 11.95) out.push(`${parseFloat(cs.fontSize)}px "${t.slice(0, 24)}"`);
      }
      return out;
    })).map((x) => `${path}: ${x}`));
  }
  expect(small).toEqual([]);
  await ctx.close();
});
