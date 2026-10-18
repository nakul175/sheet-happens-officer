// SHO-US-22.8 Concierge on phones (APL-2556). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project, archived afterwards. The concierge tests need the concierge switched ON on the
// server (a model key and MODEL_DATA_APPROVED); when it is off they skip, and AC4 (the off notice) runs instead.
// Skipped always: Confirm/Cancel (AC2 part) and the undo toast (AC5) need the concierge to propose a change through the model, which a story test must not trigger.
import { test, expect, zz } from "../support";
import type { Page } from "@playwright/test";
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
let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.8 concierge"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

async function openConcierge(page: Page) {
  await page.goto("/", { waitUntil: "load" });
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Concierge" }).click();
  const sheet = page.getByRole("dialog", { name: "Concierge" });
  await expect(sheet).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const on = (await page.getByLabel("Message the concierge").count()) > 0;
  return { sheet, on };
}

test("AC1: the concierge fills the visible screen with the composer inside it (keyboard part needs a device)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet, on } = await openConcierge(page);
  test.skip(!on, "The concierge is not switched on on this server.");
  const b = (await sheet.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(780 * 0.95);
  expect(b.width).toBeGreaterThanOrEqual(390 * 0.98);
  const c = (await page.getByLabel("Message the concierge").boundingBox())!;
  expect(c.y + c.height).toBeLessThanOrEqual(780);
  await ctx.close();
});

test("AC2: the quick chips are at least 44 px high", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { on } = await openConcierge(page);
  test.skip(!on, "The concierge is not switched on on this server.");
  const chips = page.getByRole("group", { name: "Quick actions" }).getByRole("button");
  expect(await chips.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await chips.count()); i++) expect((await chips.nth(i).boundingBox())!.height, `chip ${i}`).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test.skip("AC2: the Confirm and Cancel buttons are at least 44 px high", () => {
  // Confirm and Cancel only appear on a card the model proposes. A story test must not call the model (cost cap, SHO-US-9.2); covered by the CI phone checks on a fixture card.
});

test("AC3: Close closes the concierge and focus returns to the entry", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet } = await openConcierge(page); // works with the concierge on or off: the sheet and its Close exist either way
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  const where = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}.${a.className}|${a.textContent?.trim().slice(0, 12)}` : ""; });
  expect(where, "focus is on the More tab or the concierge button, not lost on <body>").toMatch(/More|Concierge|fab/i);
  await ctx.close();
});

test("AC3: Back closes the concierge", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet } = await openConcierge(page);
  await page.goBack().catch(() => {});
  await expect(sheet).toHaveCount(0);
  await ctx.close();
});

test("AC4: when the concierge is switched off the notice shows and the rest of the app works", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  const { sheet, on } = await openConcierge(page);
  test.skip(on, "The concierge is switched on on this server, so there is no off notice to see.");
  await expect(sheet.locator(".cc-disabled")).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  await expect(page.getByRole("button", { name: "+ Add task" }).first()).toBeVisible({ timeout: 30000 });
  await ctx.close();
});

test.skip("AC5: the undo toast does not overlap the entry or a bottom bar", () => {
  // An undo toast only appears after a confirmed concierge change, which needs the model. The same toast's position is covered for ordinary changes in SHO-US-14.5's tests.
});
