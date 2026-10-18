// SHO-US-22.3 Forms that do not zoom or hide under the keyboard (APL-2551). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project and tasks, archived afterwards.
// AC2, AC3 and AC4's keyboard parts need a real iPhone / Android keyboard (the story says so); they are skipped with that reason.
import { test, expect, zz } from "../support";
import { collect } from "../../viewport/checks";
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

let projectId = "", taskId = "", longId = "";
const LONG = "L".repeat(10) + " " + "words and more words ".repeat(7).slice(0, 139); // 150 characters
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.3 forms"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  taskId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.3 task") })).json.task.id;
  longId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: LONG })).json.task.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("AC1: every input, select and textarea is at least 16 px at 320 and 600 px", async ({ browser }) => {
  test.setTimeout(180_000);
  const bad: string[] = [];
  for (const w of [320, 600]) {
    const ctx = await phone(browser, w);
    const page = await ctx.newPage();
    for (const path of ["/", "/projects/new", `/projects/${projectId}`, `/projects/${projectId}?task=${taskId}`, "/search", "/profile", "/team"]) {
      await page.goto(path, { waitUntil: "load" });
      await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
      for (const f of (await page.evaluate(collect, w < 600)).filter((x) => x.check === "field")) bad.push(`${w}px ${path}: ${f.element} ${f.detail}`);
    }
    await ctx.close();
  }
  expect(bad).toEqual([]);
});

test.skip("AC2: tapping a field on an iPhone does not zoom the page", () => {
  // Needs a real iPhone: desktop Chromium does not auto-zoom. The 16 px rule it depends on is tested in AC1; the viewport rule in SHO-US-22.1.
});

test("AC3: the concierge composer and Send are fully visible on a phone (keyboard part needs a device)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "load" });
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Concierge" }).click();
  const box = page.getByLabel("Message the concierge");
  await expect(box).toBeVisible();
  const send = page.getByRole("button", { name: "Send" });
  for (const el of [box, send]) {
    const b = (await el.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(844);
  }
  await ctx.close();
});

test.skip("AC3: composer and Send stay visible with the on-screen keyboard open", () => {
  // Needs a real iPhone and Android keyboard (visualViewport resizes); not reproducible in desktop Chromium.
});

test("AC4: in the task panel the description field and the footer actions are reachable (keyboard part needs a device)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const desc = page.locator("#desc");
  await desc.scrollIntoViewIfNeeded();
  await expect(desc).toBeVisible();
  await desc.fill("ZZ-TEST description");
  await page.getByLabel("Title").first().focus(); // leaves the field: the panel saves on blur
  const close = page.getByRole("button", { name: "Close" }).first();
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  await ctx.close();
});

test("AC5: Search on a phone does not open the keyboard by itself", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto("/search", { waitUntil: "load" });
  await expect(page.getByLabel("Search", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
  await ctx.close();
});

test("AC6: a 150-character title wraps and stays editable without sideways scrolling", async ({ browser, admin }) => {
  expect(LONG.length).toBe(150);
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${longId}`, { waitUntil: "load" });
  const title = page.getByLabel("Title").first();
  await expect(title).toBeVisible();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw).toBeLessThanOrEqual(m.iw + 1);
  const t = await title.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, h: e.getBoundingClientRect().height }));
  expect(t.sw).toBeLessThanOrEqual(t.cw + 1);
  expect(t.h).toBeGreaterThan(40); // wrapped onto more than one line
  const edited = zz("22.3 edited");
  await title.fill(edited);
  await title.blur();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${longId}`)).json.task.title).toBe(edited);
  await ctx.close();
});

test("Prohibited: the viewport does not use maximum-scale=1", async ({ admin }) => {
  await admin.page.goto("/");
  expect((await admin.page.locator('meta[name="viewport"]').getAttribute("content")) ?? "").not.toMatch(/maximum-scale/);
});
