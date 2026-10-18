// SHO-US-22.2 Touch targets (APL-2550). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project with two tasks, archived afterwards.
import { test, expect, zz } from "../support";
import { collect } from "../../viewport/checks";
import type { Browser } from "@playwright/test";

async function phone(browser: Browser, width: number, height = 800, touch = true) {
  const ctx = await browser.newContext({
    baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL!, password: process.env.SHO_ADMIN_PASS! } });
  expect(r.ok(), "sign in").toBe(true);
  return ctx;
}

let projectId = "", taskId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.2 targets"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  const t = await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.2 first") });
  taskId = t.json.task.id;
  await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.2 second") });
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

const screens = () => ["/", "/projects", `/projects/${projectId}`, `/projects/${projectId}?view=board`, `/projects/${projectId}?task=${taskId}`, "/team", "/search", "/profile"];

async function undersized(browser: Parameters<typeof phone>[0], widths: number[]) {
  const bad: string[] = [];
  for (const w of widths) {
    const ctx = await phone(browser, w);
    const page = await ctx.newPage();
    for (const path of screens()) {
      await page.goto(path, { waitUntil: "load" });
      await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
      const found = await page.evaluate(collect, true);
      for (const f of found.filter((x) => x.check === "target")) bad.push(`${w}px ${path}: ${f.element} ${f.detail}`);
    }
    await ctx.close();
  }
  return bad;
}

test.describe.configure({ timeout: 180_000 });
test("AC1: every button, link, input, select, checkbox and menu item has a 44 x 44 px hit area at 320 and 600 px", async ({ browser }) => {
  expect(await undersized(browser, [320, 600])).toEqual([]);
});

// Product defect found 18 Oct 2026: on a 390 px project list the three inline-edit cells (assignee, date, priority; SHO-US-14.8)
// overlap each other by 6 px and sit 1 px under the Complete tick, so AC2 (8 px between hit areas) does not hold. Remove test.fail() when fixed.
test("AC2: adjacent targets in a task row are at least 8 px apart", async ({ browser }) => {
  test.fail(true, "SHO-US-22.2 AC2 not met: .ic-cell hit areas overlap by 6 px (found against dbfbab2)");
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  await expect(page.getByText(zz("22.2 first")).first()).toBeVisible();
  const gaps = await page.evaluate(() => {
    // The hit area of a control is its box plus any invisible ::after area.
    const area = (e: Element) => {
      const r = e.getBoundingClientRect();
      const af = getComputedStyle(e, "::after");
      const i = af.content !== "none" && af.position === "absolute" ? [af.top, af.right, af.bottom, af.left].map(parseFloat) : [0, 0, 0, 0];
      return { t: r.top - (i[0] < 0 ? -i[0] : 0), b: r.bottom + (i[2] < 0 ? -i[2] : 0), l: r.left - (i[3] < 0 ? -i[3] : 0), r: r.right + (i[1] < 0 ? -i[1] : 0) };
    };
    const out: string[] = [];
    const rows = Array.from(document.querySelectorAll(".item")).slice(0, 4);
    for (const row of rows) {
      const els = Array.from(row.querySelectorAll<HTMLElement>("button,a[href],input:not([type=hidden]),select")).filter((e) => e.getBoundingClientRect().width > 0);
      for (let a = 0; a < els.length; a++) for (let b = a + 1; b < els.length; b++) {
        const x = area(els[a]), y = area(els[b]);
        const gx = Math.max(y.l - x.r, x.l - y.r), gy = Math.max(y.t - x.b, x.t - y.b);
        const gap = Math.max(gx, gy);
        if (gap < 8) out.push(`${els[a].outerHTML.slice(0, 50)} vs ${els[b].outerHTML.slice(0, 50)} gap ${Math.round(gap)}`);
      }
    }
    return out;
  });
  expect(gaps).toEqual([]);
  await ctx.close();
});

test("AC3: a finger that moves more than 10 px on a row opens nothing and completes nothing", async ({ browser, admin }) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item", { hasText: zz("22.2 first") }).first();
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(600);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(page.url()).not.toContain("task=");
  const t = await admin.api.get(`/api/tasks/${taskId}`);
  expect(t.json.task.completedAt ?? null).toBeNull();
  await ctx.close();
});

test("AC4: the phone audit reports 0 undersized targets at 320, 360, 390, 414 and 599 px", async ({ browser }) => {
  test.setTimeout(300_000);
  // Same in-page audit the CI phone checks use (tests/viewport/checks.ts), over the screens above.
  expect(await undersized(browser, [320, 360, 390, 414, 599])).toEqual([]);
});

test("Prohibited: the Complete tick is not hidden on phones", async ({ browser }) => {
  const ctx = await phone(browser, 360);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item", { hasText: zz("22.2 first") }).first();
  await expect(row.locator('input[type=checkbox], button[aria-label*="omplete"], button[aria-label*="done"]').first()).toBeVisible();
  await ctx.close();
});
