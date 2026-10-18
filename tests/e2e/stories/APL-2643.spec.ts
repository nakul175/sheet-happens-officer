// SHO-BUG-9 Notification bell spoken label omits visible unread count, WCAG 2.5.3 (Linear APL-2643, PR #18). Acceptance criteria AC1 to AC3.
// The unread count is set in the browser (tests/e2e/helpers/jim-bell.ts), so no notification is created and no real notice is read.
// The file skips only when SHO_QA_PASS is unset. Over 99 unread the name must be "Notifications, 99+ unread" (the fix on main).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "../support";
import { bell, withUnread } from "../helpers/jim-bell";
import { PASS, passwordOk } from "./qa";

// Pam has not published a TC hash. The marker is the literal "qa:TC missing".
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: "qa:TC missing" }] });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

const RULE = "label-content-name-mismatch";

/** The bell's result for the Label in Name rule: violation, pass, incomplete (cannot judge), inapplicable or not run. */
async function labelInName(page: Page) {
  const r = await new AxeBuilder({ page }).include("button[aria-label^='Notifications']").withRules([RULE]).analyze();
  const on = (list: { id: string }[]) => list.some((x) => x.id === RULE);
  return { violations: r.violations.filter((x) => x.id === RULE), ran: on(r.violations) || on(r.passes) || on(r.incomplete) || on(r.inapplicable) };
}

test.describe("SHO-BUG-9 / APL-2643", () => {
  test("AC1 (3 unread): the bell is named \"Notifications, 3 unread\" and shows 3", tag("APL-2643 AC1"), async ({ admin }) => {
    await withUnread(admin.page, () => 3);
    await expect(bell(admin.page).getByText("3", { exact: true })).toBeVisible();
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 3 unread");
    await expect(admin.page.getByRole("button", { name: "Notifications, 3 unread", exact: true })).toBeVisible();
  });

  test("AC1 (more than 99 unread): the bell shows 99+ and is named \"Notifications, 99+ unread\"", tag("APL-2643 AC1"), async ({ admin }) => {
    await withUnread(admin.page, () => 120);
    await expect(bell(admin.page).getByText("99+", { exact: true })).toBeVisible();
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 99+ unread");
    await expect(admin.page.getByRole("button", { name: "Notifications, 99+ unread", exact: true })).toBeVisible();
  });

  test("AC2 (0 unread): the bell is named \"Notifications\" with no badge, and no stale count after the unread go", tag("APL-2643 AC2"), async ({ admin }) => {
    let unread = 3;
    await withUnread(admin.page, () => unread);
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications, 3 unread");
    unread = 0;
    const reloaded = admin.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/notifications");
    await bell(admin.page).click(); // opening the panel loads the count again
    await reloaded;
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    await expect(bell(admin.page)).toHaveText("🔔");
    await admin.page.keyboard.press("Escape");
    await admin.page.reload();
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    await expect(bell(admin.page)).toHaveText("🔔");
  });

  test("AC3 (0 unread): axe label-content-name-mismatch finds no violation on the bell", tag("APL-2643 AC3"), async ({ admin }) => {
    await withUnread(admin.page, () => 0);
    await expect(bell(admin.page)).toHaveAttribute("aria-label", "Notifications");
    const r = await labelInName(admin.page);
    expect(r.ran, `axe ran ${RULE}`).toBe(true);
    expect(r.violations).toEqual([]); // an emoji-only bell comes back "incomplete" (cannot judge), never a violation
  });

  test("AC3 (more than 99 unread): axe label-content-name-mismatch finds no violation on the bell", tag("APL-2643 AC3"), async ({ admin }) => {
    await withUnread(admin.page, () => 120);
    await expect(bell(admin.page).getByText("99+", { exact: true })).toBeVisible();
    const r = await labelInName(admin.page);
    expect(r.ran, `axe ran ${RULE}`).toBe(true);
    expect(r.violations).toEqual([]);
  });
});
