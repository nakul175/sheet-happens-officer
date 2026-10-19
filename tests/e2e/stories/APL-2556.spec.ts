// SHO-US-22.8 Concierge on phones (APL-2556). Epic SHO-E22.
// Runs against the real app. Nothing paints /api/concierge/state or dispatches a made-up undo id.
// Confirm and Cancel cannot be raised without a model card, so that check reads the phone stylesheet (@static).
// The undo toast is the real x-undo-id from a priority change, handed to the same sho:undo event the app raises.
import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { test, expect, zz, login, BASE_URL } from "../support";
import { newTask } from "../g2";

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box | null, b: Box | null) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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
test.describe("phone", () => {
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

/** A real priority change. The toast uses the undo id the server sent. A missing id fails the test. */
async function raiseRealUndo(page: Page, taskId: string, expectedUpdatedAt: string, priority: "LOW" | "HIGH") {
  return page.evaluate(async (arg: { taskId: string; expectedUpdatedAt: string; priority: string }) => {
    const res = await fetch(`/api/tasks/${arg.taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: arg.priority, expectedUpdatedAt: arg.expectedUpdatedAt }),
    });
    const id = res.headers.get("x-undo-id");
    const body = await res.text();
    if (id && res.ok) {
      window.dispatchEvent(new CustomEvent("sho:undo", {
        detail: {
          id,
          label: res.headers.get("x-undo-label") ?? "Done",
          notified: res.headers.get("x-undo-notified") === "1",
        },
      }));
    }
    return { status: res.status, id, body };
  }, { taskId, expectedUpdatedAt, priority });
}

test("AC1: the concierge fills the visible screen with the composer inside it (keyboard part needs a device)", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const state = await (await ctx.request.get("/api/concierge/state")).json();
    const sheet = await openConcierge(page);
    const b = (await sheet.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(780 * 0.95);
    expect(b.width).toBeGreaterThanOrEqual(390 * 0.98);
    // The dock composer is also in the DOM on My tasks. Only the sheet's field counts.
    const composers = sheet.getByLabel("Message the concierge");
    if (await composers.count() === 1) {
      const c = (await composers.boundingBox())!;
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + c.height).toBeLessThanOrEqual(780);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.width).toBeLessThanOrEqual(390);
    } else {
      expect(await composers.count(), "the sheet has one composer, or none while the concierge is paused").toBe(0);
      const note = sheet.locator(".cc-disabled");
      await expect(note).toBeVisible();
      const message = state.disabled?.message as string | undefined;
      if (message) await expect(note).toContainText(message);
    }
  } finally { await ctx.close(); }
});

test("AC2: the quick chips are at least 44 px high", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    const group = sheet.getByRole("group", { name: "Quick actions" });
    if (await group.count() === 0) {
      await expect(sheet.locator(".cc-disabled")).toBeVisible();
    } else {
      const chips = group.getByRole("button");
      expect(await chips.count()).toBeGreaterThan(0);
      for (let i = 0; i < (await chips.count()); i++) expect((await chips.nth(i).boundingBox())!.height, `chip ${i}`).toBeGreaterThanOrEqual(44);
    }
  } finally { await ctx.close(); }
});

test("AC3: Close closes the concierge and focus returns to the entry", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    // Focus is scheduled with setTimeout(0) after Back. Retry until the button has it.
    await expect(page.locator("button.fab")).toBeFocused();
  } finally { await ctx.close(); }
});

test("AC3: Back closes the concierge", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    await page.goBack().catch(() => {});
    await expect(sheet).toHaveCount(0);
  } finally { await ctx.close(); }
});

test("AC4: when the concierge is switched off the notice shows and the rest of the app works", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser }) => {
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const state = await (await ctx.request.get("/api/concierge/state")).json();
    const sheet = await openConcierge(page);
    const note = sheet.locator(".cc-disabled");
    if (state.disabled?.message) {
      await expect(note).toBeVisible();
      await expect(note).toContainText(state.disabled.message as string);
    } else {
      await expect(note).toHaveCount(0);
    }
    await sheet.getByRole("button", { name: "Close" }).click();
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await expect(page.getByRole("button", { name: "+ Add task" }).first()).toBeVisible({ timeout: 30000 });
  } finally { await ctx.close(); }
});

test("AC5: the undo toast does not overlap the entry or a bottom bar", { annotation: { type: "qa:TC", description: "missing" } }, async ({ browser, admin }) => {
  const id = await newTask(admin, projectId, { title: zz("toast"), priority: "MEDIUM" });
  const ctx = await phone(browser, 390, 780);
  const page = await ctx.newPage();
  try {
    const sheet = await openConcierge(page);
    const toast = page.locator(".undo-toast");
    const seen = async () => (await admin.api.get(`/api/tasks/${id}`)).json.task.updatedAt as string;
    const first = await raiseRealUndo(page, id, await seen(), "HIGH");
    expect(first.status, first.body).toBe(200);
    expect(first.id, `the priority change is undoable. Reply was: ${first.body}`).toBeTruthy();
    await expect(toast).toBeVisible();
    const openBox = await toast.boundingBox();
    expect(overlaps(openBox, await page.locator("button.fab").boundingBox())).toBe(false);
    expect(overlaps(openBox, await page.locator("nav.tabbar").boundingBox())).toBe(false);
    expect(openBox!.y, "with the sheet open the toast sits at the top, clear of the tab bar").toBeLessThan(160);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    const second = await raiseRealUndo(page, id, await seen(), "LOW");
    expect(second.status, second.body).toBe(200);
    expect(second.id, `the second change is undoable. Reply was: ${second.body}`).toBeTruthy();
    await expect(toast).toBeVisible();
    const closed = await toast.boundingBox();
    expect(overlaps(closed, await page.locator("button.fab").boundingBox())).toBe(false);
    expect(overlaps(closed, await page.locator("nav.tabbar").boundingBox())).toBe(false);
  } finally { await ctx.close(); }
});
});

// @static: a card cannot be shown without a model call or a painted payload. The phone rule is the check.
// Kept outside the phone describe so it does not sign in or launch a browser.
test("AC2: the Confirm and Cancel buttons are at least 44 px high", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const css = readFileSync("src/components/concierge/phone.css", "utf8");
  expect(css).toContain(".cc-actions .btn, .cc-result .btn, .cc-rewrite .btn, .cc-voice-notice .btn { min-height: 44px; min-width: 44px; }");
  expect(css).toContain(".cc-chip { min-height: 44px;");
});
