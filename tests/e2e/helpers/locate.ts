// Locators for story specs. Role, label, text and title only. No CSS class, no .first().
import type { Locator, Page } from "@playwright/test";

/** A deals-board column. Its accessible name is the stage name. */
export function stageColumn(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true });
}

/** The deal's name link on the board, inside main so the side nav is not included. */
export function dealLink(page: Page, name: string) {
  return page.getByRole("main").getByRole("link", { name, exact: true });
}

/** A status message. role=status does not take its accessible name from its text. */
export function statusText(page: Page, text: string) {
  return page.getByRole("status").filter({ hasText: text });
}

/** The breadcrumb line. On a project or deal it is the heading; on an organisation it is the line under the heading. */
export function breadcrumb(page: Page, root: "Accounts" | "Projects" | "Deals") {
  return page.getByRole("main").getByRole("link", { name: root, exact: true }).locator("xpath=ancestor::*[self::h1 or self::p][1]");
}

/**
 * The list row for a name drawn in bold. A checkbox label repeats the same name and is not bold,
 * so it is not this row. `levels` is how many divs sit between that bold name and the row:
 * a contact row is 3, a Leaders row is 2.
 */
export function rowAround(scope: Page | Locator, text: string, levels = 3) {
  return scope.getByText(text, { exact: true }).locator(`xpath=ancestor-or-self::b[1]/ancestor::div[${levels}]`);
}

/**
 * A note row. The note text is its own div; the row is the div above that div's parent.
 * Deal notes put a link in the parent, so the nearest div that contains a link is not the row.
 */
export function noteRow(scope: Page | Locator, text: string) {
  return scope.getByText(text, { exact: true }).locator("xpath=parent::div/parent::div");
}

/** The list row around a link whose parent is the text block (a review idea, a deal card). */
export function rowFromLink(link: Locator) {
  return link.locator("xpath=parent::div/parent::div");
}

/** Scroll a control to the centre so the phone tab bar does not cover it. */
export async function scrollClear(target: Locator) {
  await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
}

/** Scroll a control to the centre so the phone tab bar does not cover it, then click. Never uses force. */
export async function clickClear(target: Locator) {
  await scrollClear(target);
  await target.click();
}

export async function metaContent(page: Page, name: string): Promise<string[]> {
  return page.evaluate((n) => [...document.querySelectorAll("meta")].filter((m) => m.getAttribute("name") === n).map((m) => m.getAttribute("content") ?? ""), name);
}

export async function linkHrefs(page: Page, rel: string): Promise<string[]> {
  return page.evaluate((r) => [...document.querySelectorAll("link")].filter((l) => l.rel === r).map((l) => l.getAttribute("href") ?? "").filter(Boolean), rel);
}
