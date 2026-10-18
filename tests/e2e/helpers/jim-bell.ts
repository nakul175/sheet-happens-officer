// The notification bell with a chosen unread count, for the APL-2643 spec and the PR #18 gate.
// The count comes from GET /api/notifications, answered in the browser (route interception): the shared Admin's real unread
// count is unknown, other shards keep adding to it, and over 99 real notices would need 100 notifications and a read-all on
// a real account. Nothing on the server is created or changed.
import type { Page } from "@playwright/test";

/** The bell button in the header. */
export const bell = (page: Page) => page.locator("button.bell");

/**
 * Answers every GET /api/notifications on `page` with `count()` unread and no items, and opens My tasks once that answer
 * has reached the page. `count` is read on each request, so a test can change it and make the bell load again.
 */
export async function withUnread(page: Page, count: () => number) {
  await page.route((u) => u.pathname === "/api/notifications", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unread: count(), items: [], next: null }) })
      : r.continue());
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/notifications");
  await page.goto("/");
  await answered;
}
