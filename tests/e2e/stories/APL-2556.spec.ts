// SHO-US-22.8 Concierge on phones (APL-2556). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project, archived afterwards.
// Confirm, Cancel and the off notice are painted from the concierge state payload, so no model call is made.
// The undo toast is the same UndoHost the app raises after a change; it is shown with the sheet open and closed.
import { test, expect, zz, login, BASE_URL } from "../support";
import type { Page, Browser } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box | null, b: Box | null) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const enabledState = {
  available: true, hidden: false, voiceNoticeAcked: true, messages: [] as unknown[],
  quickActions: [
    { id: "due-week", label: "Due this week" },
    { id: "overdue", label: "Overdue" },
    { id: "waiting-on-me", label: "Waiting on me" },
    { id: "blocked", label: "Blocked" },
    { id: "recently-completed", label: "Recently completed" },
  ],
};

const offState = {
  available: false, hidden: false, voiceNoticeAcked: true, messages: [] as unknown[], quickActions: [],
  disabled: { code: "NOT_ENABLED", message: "The concierge is not switched on yet." },
};

const cardState = {
  ...enabledState,
  messages: [{
    id: "zz-card", role: "ASSISTANT", createdAt: new Date().toISOString(), kind: "card", text: "ZZ-TEST review this.",
    card: {
      id: "zz-card", status: "PENDING", title: "ZZ-TEST change", canConfirm: true,
      changes: [{ label: "Due", before: "today", after: "Monday" }],
    },
  }],
};

async function fulfillState(page: Page, body: unknown) {
  await page.route("**/api/concierge/state", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(body),
  }));
}

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
  return sheet;
}

test("AC1: the concierge fills the visible screen with the composer inside it (keyboard part needs a device)", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    await fulfillState(page, enabledState);
    const sheet = await openConcierge(page);
    const b = (await sheet.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(780 * 0.95);
    expect(b.width).toBeGreaterThanOrEqual(390 * 0.98);
    const c = (await page.getByLabel("Message the concierge").boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(780);
  } finally { await ctx.close(); }
});

test("AC2: the quick chips are at least 44 px high", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    await fulfillState(page, enabledState);
    await openConcierge(page);
    const chips = page.getByRole("group", { name: "Quick actions" }).getByRole("button");
    expect(await chips.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await chips.count()); i++) expect((await chips.nth(i).boundingBox())!.height, `chip ${i}`).toBeGreaterThanOrEqual(44);
  } finally { await ctx.close(); }
});

test("AC2: the Confirm and Cancel buttons are at least 44 px high", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    await fulfillState(page, cardState);
    const sheet = await openConcierge(page);
    for (const name of ["Confirm", "Cancel"]) {
      const box = await sheet.getByRole("button", { name }).boundingBox();
      expect(box, name).toBeTruthy();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
  } finally { await ctx.close(); }
});

test("AC3: Close closes the concierge and focus returns to the entry", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    const where = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName}.${a.className}|${a.textContent?.trim().slice(0, 40)}` : "";
    });
    expect(where, "focus is on the More tab or the concierge button, not lost on <body>").toMatch(/More|Concierge|fab/i);
  } finally { await ctx.close(); }
});

test("AC3: Back closes the concierge", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    await page.goBack().catch(() => {});
    await expect(sheet).toHaveCount(0);
  } finally { await ctx.close(); }
});

test("AC4: when the concierge is switched off the notice shows and the rest of the app works", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    await fulfillState(page, offState);
    const sheet = await openConcierge(page);
    await expect(sheet.locator(".cc-disabled")).toBeVisible();
    await expect(sheet.locator(".cc-disabled")).toContainText(/not switched on yet|not enabled/i);
    await sheet.getByRole("button", { name: "Close" }).click();
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await expect(page.getByRole("button", { name: "+ Add task" }).first()).toBeVisible({ timeout: 30000 });
  } finally { await ctx.close(); }
});

test("AC5: the undo toast does not overlap the entry or a bottom bar", async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("sho:undo", { detail: { id: "zz-toast", label: "ZZ-TEST change", notified: false } }));
    });
    const toast = page.locator(".undo-toast");
    await expect(toast).toBeVisible();
    const openBox = await toast.boundingBox();
    expect(overlaps(openBox, await page.locator("button.fab").boundingBox())).toBe(false);
    expect(overlaps(openBox, await page.locator("nav.tabbar").boundingBox())).toBe(false);
    expect(openBox!.y, "with the sheet open the toast sits at the top, clear of the tab bar").toBeLessThan(160);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("sho:undo", { detail: { id: "zz-toast-2", label: "ZZ-TEST change", notified: false } }));
    });
    await expect(toast).toBeVisible();
    const closed = await toast.boundingBox();
    expect(overlaps(closed, await page.locator("button.fab").boundingBox())).toBe(false);
    expect(overlaps(closed, await page.locator("nav.tabbar").boundingBox())).toBe(false);
  } finally { await ctx.close(); }
});
