// SHO-US-22.6 Board on phones (APL-2554). Epic SHO-E22.
// Runs against staging. Data: ZZ-TEST projects with ZZ-TEST tasks, archived afterwards. AC3 needs SHO_MEMBER_EMAIL / SHO_MEMBER_PASS.
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

test.describe.configure({ retries: 2 }); // the phone-size runs share one server; two retries absorb a dropped request
const LONGTITLE = "W".repeat(100);
let projectId = "", todo = "", doing = "", done = "", taskId = "", parentId = "", longId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.6 board"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  const secs = (await admin.api.get(`/api/projects/${projectId}`)).json.project.sections as { id: string; isDone: boolean }[];
  todo = secs[0].id; doing = secs[1].id; done = secs.find((s) => s.isDone)!.id;
  taskId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.6 card"), sectionId: todo })).json.task.id;
  parentId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.6 parent"), sectionId: todo })).json.task.id;
  await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("22.6 open subtask"), parentId });
  longId = (await admin.api.post(`/api/projects/${projectId}/tasks`, { title: LONGTITLE, sectionId: todo })).json.task.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

const board = (id: string) => `/projects/${id}?view=board`;

test("AC1: at 320 to 599 px one column fills the width, at most 16 px of the next shows, and a switcher shows each name and count", async ({ browser }) => {
  for (const w of [320, 390, 599]) {
    const ctx = await phone(browser, w, 800);
    const page = await ctx.newPage();
    await page.goto(board(projectId), { waitUntil: "load" });
    await expect(page.locator(".board .col").first()).toBeVisible({ timeout: 30000 });
    const g = await page.evaluate(() => {
      const cols = Array.from(document.querySelectorAll<HTMLElement>(".board .col")).map((c) => c.getBoundingClientRect());
      return { vw: window.innerWidth, first: cols[0], second: cols[1] };
    });
    expect(g.first.width, `${w}px: first column width`).toBeGreaterThanOrEqual(g.vw - 40);
    expect(g.first.width).toBeLessThanOrEqual(g.vw);
    expect(g.vw - g.second.left, `${w}px: how much of the next column shows`).toBeLessThanOrEqual(16);
    const tabs = page.getByRole("tablist", { name: "Board columns" }).getByRole("tab");
    expect(await tabs.count()).toBeGreaterThanOrEqual(3);
    await expect(tabs.first()).toContainText(/\d/); // the count
    await expect(tabs.first()).toContainText(/to do|todo|not started/i);
    await ctx.close();
  }
});

test("AC2: Move to… is at least 44 px, opens a sheet of sections with 44 px rows, moves the task and shows the Undo toast", async ({ browser, admin }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(board(projectId), { waitUntil: "load" });
  const btn = page.getByRole("button", { name: `Move to… "${zz("22.6 card")}"` });
  await btn.scrollIntoViewIfNeeded();
  const b = (await btn.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  await btn.click();
  const sheet = page.getByRole("dialog", { name: /Move to…/ });
  await expect(sheet).toBeVisible();
  const rows = sheet.locator(".msheet-row");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < (await rows.count()); i++) expect((await rows.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sheet.locator(".msheet-row", { hasText: /^In progress|^Doing/i }).first().click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.section.id).toBe(doing);
  await expect(page.getByRole("button", { name: "Undo" }).first()).toBeVisible();
  await ctx.close();
});

test("AC3: a Viewer sees no Move control", async ({ browser, admin, member }) => {
  expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const ctx = await phone(browser, 390, 800, true, "member");
  const page = await ctx.newPage();
  await page.goto(board(projectId), { waitUntil: "load" });
  await expect(page.locator(".bcard").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("button", { name: /^Move to…/ })).toHaveCount(0);
  await ctx.close();
});

test("AC4: moving a task with open subtasks to Done asks 'Complete them all'", async ({ browser, admin }) => {
  const ctx = await phone(browser, 390, 800);
  const page = await ctx.newPage();
  await page.goto(board(projectId), { waitUntil: "load" });
  const btn = page.getByRole("button", { name: `Move to… "${zz("22.6 parent")}"` });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.getByRole("dialog", { name: /Move to…/ }).locator(".msheet-row", { hasText: /Done/i }).first().click();
  const ask = page.getByRole("dialog", { name: /Open subtasks/ });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "Complete them all" })).toBeVisible();
  // Nothing moved yet.
  expect((await admin.api.get(`/api/tasks/${parentId}`)).json.task.section.id).toBe(todo);
  await ctx.close();
});

test("AC5: a 100-character unbreakable title wraps and the card does not exceed the column at 320 px", async ({ browser }) => {
  const ctx = await phone(browser, 320, 800);
  const page = await ctx.newPage();
  await page.goto(board(projectId), { waitUntil: "load" });
  const card = page.locator(".bcard", { hasText: LONGTITLE.slice(0, 20) }).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  const m = await card.evaluate((c) => { const col = c.closest(".col")!.getBoundingClientRect(); const r = c.getBoundingClientRect(); return { cl: col.left, cr: col.right, l: r.left, r: r.right, sw: c.scrollWidth, cw: c.clientWidth }; });
  expect(m.r).toBeLessThanOrEqual(m.cr + 1);
  expect(m.l).toBeGreaterThanOrEqual(m.cl - 1);
  expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
  const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
  await ctx.close();
});

test("AC6: on a mouse device 1024 px or wider, dragging a card to another column still works", async ({ browser, admin }) => {
  const ctx = await phone(browser, 1280, 900, false);
  const page = await ctx.newPage();
  await page.goto(board(projectId), { waitUntil: "load" });
  const card = page.locator(".bcard", { hasText: zz("22.6 card") }).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.getByRole("button", { name: /^Move to…/ })).toBeVisible(); // the button exists beside dragging; it is not removed on desktop
  const target = page.locator(".col").nth(1);
  await card.dragTo(target);
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.section.id, { timeout: 15000 }).toBe(doing);
  await ctx.close();
});

test("Prohibited: who may move a task is unchanged (the server refuses a Viewer's move)", async ({ admin, member }) => {
  expect((await admin.api.post(`/api/projects/${projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const r = await member.api.post(`/api/tasks/${taskId}/move`, { sectionId: doing });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.section.id).toBe(todo);
});
