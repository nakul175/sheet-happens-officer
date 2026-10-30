import { expect } from "vitest";
import type { Page } from "playwright-core";
import { TASK_TITLE, type Ids, type Screen } from "./screens";

/** Refuse fixture writes outside a loopback app and an explicitly named disposable QA database. */
export function requireLocalFixtures(base: string, databaseUrl: string | undefined) {
  try {
    const app = new URL(base), database = new URL(databaseUrl ?? "");
    if ([app, database].every(u => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) && /^\/sho_(?:test|viewport)[\w-]*$/.test(database.pathname)) return;
  } catch { /* Use one safe error without printing a connection string. */ }
  throw new Error("Refusing viewport/axe fixtures: use a loopback app and local synthetic sho_test* or sho_viewport* database.");
}

/** Both layout and axe must audit the requested, loaded fixture rather than an error or another screen. */
export async function openScreen(page: Page, screen: Screen, ids: Ids, base: string) {
  const path = screen.path(ids);
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response?.ok(), `${path} must load successfully, not an error page`).toBe(true);
  // Next can retain hidden skeletons from an inactive page after the known legacy task redirect.
  await page.waitForFunction(() => ![...document.querySelectorAll(".skel, .skel-wrap")].some(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"), undefined, { timeout: 15000 });
  if (screen.wait) await page.waitForSelector(screen.wait, { timeout: 10000 });
  if (screen.heading) await page.getByRole("heading", { name: screen.heading, exact: true }).waitFor();
  if (screen.taskPanel || screen.taskPage) {
    const title = (screen.taskPanel ? page.getByRole("dialog") : page).getByRole("textbox", { name: "Title", exact: true });
    await title.waitFor();
    expect(await title.inputValue(), "the requested task must actually be loaded").toBe(TASK_TITLE);
  }
  const actual = new URL(page.url()), requested = new URL(path, base);
  const expected = screen.canonical && actual.pathname !== requested.pathname ? new URL(screen.canonical(ids), base) : requested;
  expect(actual.origin, "stay on the isolated app origin").toBe(expected.origin);
  expect(actual.pathname, `${path} must stay on its screen or documented task destination`).toBe(expected.pathname);
  for (const [key, value] of expected.searchParams) expect(actual.searchParams.get(key), `preserve requested ${key}`).toBe(value);
}
