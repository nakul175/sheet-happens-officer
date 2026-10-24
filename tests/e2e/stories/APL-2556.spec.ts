// SHO-US-22.8 Concierge on phones (APL-2556). Epic SHO-E22.
// Runs against staging. Data: one ZZ-TEST project, archived afterwards. The concierge tests need the concierge switched ON on the
// server (a model key and MODEL_DATA_APPROVED); when it is off they skip, and AC4 (the off notice) runs instead.
// Card dimensions use a real model proposal; toast geometry uses a real reversible task write.
import { test, expect, zz, login, BASE_URL } from "../support";
import type { Page } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, requireModel, showConcierge } from "../helpers/jim-concierge";

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
  const c = (await sheet.getByLabel("Message the concierge", { exact: true }).boundingBox())!;
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

test("AC2: the Confirm and Cancel buttons are at least 44 px high", async ({ browser, admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  await showConcierge(admin, later);
  const title = zz("phone-card");
  await newTask(admin, projectId, { title, assigneeId: admin.user.id });
  const reply = await ask(admin, `Set the priority of "${title}" to high.`);
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  expect(cardOf(reply.messages)?.canConfirm).toBe(true);
  const ctx = await phone(browser, 390, 780);
  try {
    const page = await ctx.newPage();
    const { sheet } = await openConcierge(page);
    for (const name of ["Confirm", "Cancel"]) {
      const button = sheet.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} has a rendered box`).not.toBeNull();
      expect(box!.height, `${name} touch target`).toBeGreaterThanOrEqual(44);
    }
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
  } finally { await ctx.close(); }
});

// The More menu item unmounts when the sheet opens; Close must restore focus to the persistent More entry.
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

test("AC5: the undo toast does not overlap the entry or a bottom bar", async ({ browser, admin }) => {
  const id = await newTask(admin, projectId, { title: zz("phone-toast"), priority: "MEDIUM" });
  const ctx = await phone(browser, 390, 780);
  try {
    const page = await ctx.newPage();
    const { sheet } = await openConcierge(page);
    const version = (await admin.api.get(`/api/tasks/${id}`)).json.task.updatedAt as string;
    // A real API write produces the same server-issued Undo header used by components/api.ts.
    const changed = await page.evaluate(async ({ id, version }) => {
      const response = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priority: "HIGH", expectedUpdatedAt: version }) });
      const undoId = response.headers.get("x-undo-id");
      if (response.ok && undoId) window.dispatchEvent(new CustomEvent("sho:undo", { detail: { id: undoId, label: response.headers.get("x-undo-label") ?? "Done", notified: response.headers.get("x-undo-notified") === "1" } }));
      return { status: response.status, undoId };
    }, { id, version });
    expect(changed.status).toBe(200);
    expect(changed.undoId).toBeTruthy();
    const toast = page.locator(".undo-toast");
    await expect(toast).toBeVisible();
    for (const open of [true, false]) {
      if (!open) await sheet.getByRole("button", { name: "Close", exact: true }).click();
      const box = await toast.boundingBox();
      expect(box).not.toBeNull();
      for (const selector of ["button.fab", "nav.tabbar"]) {
        const other = await page.locator(selector).boundingBox();
        if (other) expect(box!.x < other.x + other.width && box!.x + box!.width > other.x && box!.y < other.y + other.height && box!.y + box!.height > other.y, `toast overlaps ${selector}; sheet open=${open}`).toBe(false);
      }
    }
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => (await admin.api.get(`/api/tasks/${id}`)).json.task.priority).toBe("MEDIUM");
  } finally { await ctx.close(); }
});
