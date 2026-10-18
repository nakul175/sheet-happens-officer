// SHO-US-22.1 Phone-ready foundations (APL-2549). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project, archived afterwards.
import { test, expect, zz, type Json, login, BASE_URL } from "../support";
import type { Browser } from "@playwright/test";

const WIDTHS = [320, 344, 360, 375, 390, 412, 440, 600, 768];

async function phone(browser: Browser, width: number, height = 800, touch = true) {
  const email = login("ADMIN").email, password = login("ADMIN").password;
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  expect((await ctx.request.post("/api/auth/signin", { data: { email, password } })).ok()).toBe(true);
  return ctx;
}

let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.1 phone"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.1 task") });
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("AC1: no sideways scroll at 320, 344, 360, 375, 390, 412, 440, 600 and 768 px", async ({ browser }) => {
  test.setTimeout(180_000); // 9 widths × 6 screens. A page that never reaches load still fails; this only gives the loop room to finish.
  for (const w of WIDTHS) {
    const ctx = await phone(browser, w);
    const page = await ctx.newPage();
    for (const path of ["/", "/projects", `/projects/${projectId}`, "/team", "/search", "/profile"]) {
      await page.goto(path, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
      expect(Math.max(m.sw, m.bw), `${path} at ${w}px scrolls sideways`).toBeLessThanOrEqual(m.iw + 1);
    }
    await ctx.close();
  }
});

test("AC2: viewport has viewport-fit=cover and a theme colour is set", async ({ admin }) => {
  await admin.page.goto("/");
  const meta = await admin.page.locator('meta[name="viewport"]').getAttribute("content");
  expect(meta).toMatch(/viewport-fit\s*=\s*cover/);
  expect(await admin.page.locator('meta[name="theme-color"]').first().getAttribute("content")).toMatch(/^#[0-9a-f]{3,8}$/i);
});

test("AC3: a phone in landscape gets the phone layout; the desktop shell starts at 1024 px", async ({ browser }) => {
  const landscape = await phone(browser, 844, 390);
  const p = await landscape.newPage();
  await p.goto("/");
  await expect(p.getByRole("button", { name: "Open menu" })).toBeVisible();
  const side = await p.locator("aside.side").evaluate((e) => { const cs = getComputedStyle(e); return { pos: cs.position, x: e.getBoundingClientRect().left, w: e.getBoundingClientRect().width }; });
  expect(side.pos === "fixed" || side.x < 0 || side.w === 0, `sidebar must be a drawer at 844px: ${JSON.stringify(side)}`).toBe(true);
  await landscape.close();
  const desktop = await phone(browser, 1024, 700, false); // a mouse device: touch tablets get larger tap areas, not the phone layout
  const d = await desktop.newPage();
  await d.goto("/");
  await expect(d.getByRole("button", { name: "Open menu" })).toBeHidden();
  await expect(d.locator("aside.side")).toBeVisible();
  await desktop.close();
});

test("AC4: no 100vh in the stylesheets without a dvh line in the same rule", async ({ admin }) => {
  await admin.page.goto("/");
  const hrefs = await admin.page.$$eval('link[rel="stylesheet"]', (l) => l.map((x) => (x as HTMLLinkElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const h of hrefs) {
    const css = await (await admin.page.request.get(h)).text();
    for (const rule of css.match(/\{[^{}]*\}/g) ?? []) {
      if (/(^|[^d])100vh/.test(rule) && !/100dvh/.test(rule)) bad.push(rule.slice(0, 120));
    }
  }
  expect(bad, "rules with 100vh and no 100dvh").toEqual([]);
});

test("Prohibited: pinch zoom is not blocked (no maximum-scale=1 or user-scalable=no)", async ({ admin }) => {
  await admin.page.goto("/");
  const meta = (await admin.page.locator('meta[name="viewport"]').getAttribute("content")) ?? "";
  expect(meta).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/);
  expect(meta).not.toMatch(/user-scalable\s*=\s*(no|0)/);
});
