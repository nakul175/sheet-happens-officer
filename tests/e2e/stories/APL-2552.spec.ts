// SHO-US-22.4 Phone navigation, bottom tab bar (APL-2552). Epic SHO-E22.
// Runs against staging. AC2's Member half needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS (skipped without them).
import { test, expect, zz, login, BASE_URL } from "../support";
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

let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.4 nav"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  for (let i = 0; i < 12; i++) await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz(`22.4 row ${i}`) });
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("AC1: under 600 px a bottom bar with 4 tabs is visible, each 44 px high, the current tab marked", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "load" });
  const tabs = page.locator("nav.tabbar").locator("a, button");
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toContainText("My tasks");
  await expect(tabs.nth(3)).toContainText("More");
  for (let i = 0; i < 4; i++) { await expect(tabs.nth(i)).toBeVisible(); const b = (await tabs.nth(i).boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(44); expect(b.width).toBeGreaterThanOrEqual(44); }
  await expect(tabs.nth(0)).toHaveAttribute("aria-current", "page");
  // It sits at the bottom edge and pads for the home indicator.
  const nb = (await page.locator("nav.tabbar").boundingBox())!;
  expect(Math.round(nb.y + nb.height)).toBe(844);
  const css = (await Promise.all((await page.$$eval('link[rel="stylesheet"]', (l) => l.map((x) => (x as HTMLLinkElement).href))).map(async (h) => (await page.request.get(h)).text()))).join("\n");
  expect(css).toMatch(/\.tabbar\s*\{[^}]*safe-area-inset-bottom/);
  await page.goto("/projects", { waitUntil: "load" });
  await expect(page.locator("nav.tabbar a").nth(1)).toHaveAttribute("aria-current", "page");
  await ctx.close();
});

test("AC1: from 600 px the bottom bar is not used", async ({ browser }) => {
  const ctx = await phone(browser, 700, 900);
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator("nav.tabbar")).toBeHidden();
  await ctx.close();
});

test("AC2: a Super Admin sees Usage and Audit under More", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "load" });
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem", { name: "Usage" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Audit" })).toBeVisible();
  for (const n of ["Team", "Profile", "Sign out"]) await expect(menu.getByRole("menuitem", { name: n })).toBeVisible();
  await ctx.close();
});

test("AC2: a Member does not see Usage or Audit, and the server refuses them too", async ({ browser, member }) => {
  const ctx = await phone(browser, 390, 844, true, "member");
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "load" });
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem", { name: "Team" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Usage$/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /^Audit/ })).toHaveCount(0);
  // Prohibited: role checks only in the UI.
  expect((await member.api.get("/api/usage")).status).toBeGreaterThanOrEqual(400);
  expect((await member.api.get("/api/audit")).status).toBeGreaterThanOrEqual(400);
  await ctx.close();
});

test("AC3: the bar hides while a field has focus (keyboard open)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto("/search", { waitUntil: "load" });
  await expect(page.locator("nav.tabbar")).toBeVisible();
  await page.getByLabel("Search", { exact: true }).focus();
  await expect(page.locator("nav.tabbar")).toBeHidden();
  await page.getByLabel("Search", { exact: true }).blur();
  await expect(page.locator("nav.tabbar")).toBeVisible();
  await ctx.close();
});

test("AC4: on a long list no floating control covers the last row", async ({ browser }) => {
  const ctx = await phone(browser, 390, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const last = page.locator(".item").last();
  await expect(last).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  const lb = (await last.boundingBox())!;
  const covers = await page.evaluate((r) => {
    const hits: string[] = [];
    for (const e of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const overlap = b.left < r.x + r.width && b.right > r.x && b.top < r.y + r.height && b.bottom > r.y;
      if (overlap) hits.push((e as HTMLElement).className + " " + (e.getAttribute("aria-label") ?? ""));
    }
    return hits;
  }, lb);
  expect(covers, "fixed elements overlapping the last row").toEqual([]);
  await ctx.close();
});
