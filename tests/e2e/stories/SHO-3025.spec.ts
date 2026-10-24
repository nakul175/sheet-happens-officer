// SHO-3025. The APL-2555 AC4 Escape test is not on this baseline: tests/e2e/stories/APL-2555.spec.ts is absent
// (`git ls-files | grep 2555` is empty, and Playwright collects no tests for it). This spec keeps the behaviour
// that test asserted - one Escape closes the task sheet and focus returns to the row - and pins the race it was
// flaky on: the sheet must answer Escape from the moment it is in the page, not from the moment a post-paint
// effect has run, and a dialog stacked over the sheet must take the Escape instead of sharing it.
// Data: one ZZ-TEST project with one ZZ-TEST task, archived afterwards.
import { test, expect, zz, login, BASE_URL } from "../support";
import type { Browser, Locator } from "@playwright/test";

async function phone(browser: Browser) {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
  expect(r.ok(), "sign in as the admin").toBe(true);
  return ctx;
}

/**
 * SHO-3025: a visible dialog is not yet a dialog that answers Escape. The sheet at `?task=` is in the SERVER's
 * HTML (measured: `aria-label="Task"` present, `body.vv-sheet` absent), so `toBeVisible()` is satisfied before the
 * app has run. The Escape listener is added in the same layout effect that moves focus into the dialog
 * (src/components/ui.tsx:47 and :72), so "the focus has landed in the dialog" is the condition that says the
 * sheet can answer a key. Waiting on it is waiting on the product, not on a duration: with the JS chunks held
 * 3 s, an Escape sent at `toBeVisible()` was dropped and the sheet stayed open; the same Escape sent after this
 * wait closed it.
 */
async function answerable(dialog: Locator) {
  await dialog.waitFor({ state: "visible" });
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), { message: "the dialog has taken the focus, so it is bound to the keyboard" }).toBe(true);
}

const TITLE = (label: string) => zz(`3025 ${label}`);
let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("3025 sheet"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  expect((await admin.api.post(`/api/projects/${projectId}/tasks`, { title: TITLE("task"), description: "A line of description.\n".repeat(30) })).status).toBe(201);
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("qa:TC missing SHO-3025 AC4: Escape closes the sheet and focus returns to the task row", async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item.click", { hasText: TITLE("task") }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Task" });
  await expect(sheet).toBeVisible();
  await answerable(sheet);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(row, "focus is back on the task row").toBeFocused();
  await ctx.close();
});

test("qa:TC missing SHO-3025 AC4: a dialog stacked over the sheet takes the Escape instead of sharing it", async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item.click", { hasText: TITLE("task") }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Task" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Move to Trash", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Move to Trash?" });
  await expect(confirm).toBeVisible();
  await answerable(confirm);

  await page.keyboard.press("Escape");
  await expect(confirm, "the dialog on top closes").toHaveCount(0);
  // The sheet must still be open, and must stay open: the URL still names the task it shows.
  expect(page.url(), "the sheet under it was not closed too").toContain("task=");
  await page.waitForTimeout(500);
  expect(page.url(), "the sheet is still open a moment later").toContain("task=");
  await expect(sheet, "the sheet under it stays open").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(page.url(), "the sheet's own Escape closed it").not.toContain("task=");
  await expect(row, "focus is back on the task row").toBeFocused();
  await ctx.close();
});

test("qa:TC missing SHO-3025 AC4: Escape pressed the instant the sheet appears still closes it", async ({ browser }) => {
  const ctx = await phone(browser);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  const row = page.locator(".item.click", { hasText: TITLE("task") }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  // A MutationObserver runs in the microtask after the commit that inserts the sheet, before any effect React
  // schedules for after the paint. That is the window the flaky run fell into: press Escape there.
  await page.evaluate(() => {
    const w = window as unknown as { __saw3025?: boolean };
    w.__saw3025 = false;
    const seen = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"][aria-label="Task"]')) return;
      seen.disconnect();
      w.__saw3025 = true;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  await row.focus();
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as unknown as { __saw3025?: boolean }).__saw3025), { message: "the sheet was inserted and Escape was pressed there" }).toBe(true);
  await expect(page.getByRole("dialog", { name: "Task" })).toHaveCount(0);
  await expect(row, "focus is back on the task row").toBeFocused();
  await ctx.close();
});
