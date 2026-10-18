// SHO-BUG-9 Notification bell spoken label omits visible unread count, WCAG 2.5.3 (Linear APL-2643, PR #18). Acceptance criteria AC1 to AC3.
// The unread count is set in the browser (tests/e2e/helpers/jim-bell.ts), so no notification is created and no real notice is read.
// PR #18 changes only the name over 99 unread ("99+"); at 0 and 3 main already reads right, so those checks always run.
// The over-99 name check runs whenever PR #18 is live (tests/e2e/helpers/jim-gate.ts) and skips otherwise. AC3's over-99 axe check
// runs either way: with the fix it must be clean, and without it the same check must fail (AC3 asks for both).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";
import { bell, withUnread } from "../helpers/jim-bell";

const RULE = "label-content-name-mismatch";
const WHY = "over 99 unread the bell is still named with the raw total, not the \"99+\" it shows.";

/** The bell's result for the Label in Name rule: violation, pass, incomplete (cannot judge), inapplicable or not run. */
async function labelInName(page: Page) {
  const r = await new AxeBuilder({ page }).include("button.bell").withRules([RULE]).analyze();
  const on = (list: { id: string }[]) => list.some((x) => x.id === RULE);
  return { violations: r.violations.filter((x) => x.id === RULE), ran: on(r.violations) || on(r.passes) || on(r.incomplete) || on(r.inapplicable) };
}

test.describe("SHO-BUG-9 / APL-2643", () => {
  test("AC1 (3 unread): the bell is named \"Notifications, 3 unread\" and shows 3", async ({ admin }) => {
    await withUnread(admin.page, () => 3);
    await expect(bell(admin.page).locator(".badge")).toHaveText("3");
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 3 unread");
    await expect(admin.page.getByRole("button", { name: "Notifications, 3 unread", exact: true })).toBeVisible();
  });

  test("AC1 (more than 99 unread): the bell shows 99+ and is named \"Notifications, 99+ unread\"", async ({ admin, later }) => {
    const gate = await prLive(18, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    await withUnread(admin.page, () => 120);
    await expect(bell(admin.page).locator(".badge")).toHaveText("99+");
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 99+ unread");
    await expect(admin.page.getByRole("button", { name: "Notifications, 99+ unread", exact: true })).toBeVisible();
  });

  test("AC2 (0 unread): the bell is named \"Notifications\" with no badge, and no stale count after the unread go", async ({ admin }) => {
    let unread = 3;
    await withUnread(admin.page, () => unread);
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 3 unread");
    unread = 0;
    const reloaded = admin.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/notifications");
    await bell(admin.page).click(); // opening the panel loads the count again
    await reloaded;
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    await expect(bell(admin.page).locator(".badge")).toHaveCount(0);
    await admin.page.keyboard.press("Escape");
    await admin.page.reload();
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    await expect(bell(admin.page).locator(".badge")).toHaveCount(0);
  });

  test("AC3 (0 unread): axe label-content-name-mismatch finds no violation on the bell", async ({ admin }) => {
    await withUnread(admin.page, () => 0);
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    const r = await labelInName(admin.page);
    expect(r.ran, `axe ran ${RULE}`).toBe(true);
    expect(r.violations).toEqual([]); // an emoji-only bell comes back "incomplete" (cannot judge), never a violation
  });

  test("AC3 (more than 99 unread): axe label-content-name-mismatch finds no violation with the fix, and finds one without it", async ({ admin, later }) => {
    const gate = await prLive(18, admin, null, later);
    await withUnread(admin.page, () => 120);
    await expect(bell(admin.page).locator(".badge")).toHaveText("99+");
    const r = await labelInName(admin.page);
    expect(r.ran, `axe ran ${RULE}`).toBe(true);
    if (gate.deployed) expect(r.violations).toEqual([]);
    else expect(r.violations, "without PR #18 the check must catch the raw total in the name").toHaveLength(1);
  });
});
