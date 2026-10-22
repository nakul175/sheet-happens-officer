// Shared checks for the Usage screen (APL-2519, APL-2641). The screen prints figures from /api/usage.
// APL-2519 AC6 v1.2 (Linear, Michael 19 Oct 2026 20:43 IST): the percentage shown is the nearest whole number, and a half
// goes up. Zero spend is 0%. A nonzero share under 1% is "<1%", decided before that rounding. A ceiling of 0 or unset shows
// "No ceiling set" and no percentage. Spend over the ceiling shows the rounded percentage plus a visible "Over ceiling" flag.
// Stubs still send the one-decimal figure /api/usage once stored; the screen must not echo it.
// Quick actions are not added into the message total.
import type { Locator, Page } from "@playwright/test";
import { expect, type Api } from "../support";

export const CHAT = "PRIVATE-CHAT-TEXT";
const IST_MS = 5.5 * 3600_000;

/** Dollars the way the screen prints them (`$` and two decimal places). */
export const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Start of the calendar month (India time) containing `now`.
 * Same rule as monthStartIST in src/lib/concierge/dates.ts: 00:00 IST is 18:30 the previous UTC day.
 */
export function monthStartIST(now = new Date()) {
  const x = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) - IST_MS);
}

export type QuickRow = { id: string; label: string; count: number };

/** The five quick actions, in the order /api/usage lists them. Counts are this month only. */
export const QUICK_ROWS: QuickRow[] = [
  { id: "due-week", label: "Due this week", count: 2 },
  { id: "overdue", label: "Overdue", count: 4 },
  { id: "waiting-on-me", label: "Waiting on me", count: 0 },
  { id: "blocked", label: "Blocked", count: 1 },
  { id: "recently-completed", label: "Recently completed", count: 3 },
];

export type UsageBody = {
  monthStart: string;
  weekStart: string;
  /** `usd` 0, null or absent is "no ceiling set" (AC6 v1.2). */
  ceiling: { usd?: number | null; spendUsd: number; percent: number };
  month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; messages: number };
  quickActions: QuickRow[];
  people: { id: string; name: string; monthCalls: number; weekCalls: number; monthCostUsd: number }[];
  chatText: string;
};

/**
 * Percentage /api/usage stores today: one decimal, half up. 10 of 80 is 12.5.
 * Stubs send this so a screen that only echoes ceiling.percent still shows the decimal.
 */
export function apiPercent(spendUsd: number, ceilingUsd: number | null | undefined) {
  if (typeof ceilingUsd !== "number" || !(ceilingUsd > 0)) return 0;
  return Math.round((spendUsd / ceilingUsd) * 1000) / 10;
}

export const NO_CEILING = "No ceiling set";
export const OVER_CEILING = "Over ceiling";

/** A ceiling the percentage is worked out against: a number above 0. 0, null or absent is "No ceiling set". */
export const hasCeiling = (ceilingUsd: number | null | undefined): ceilingUsd is number =>
  typeof ceilingUsd === "number" && Number.isFinite(ceilingUsd) && ceilingUsd > 0;

/**
 * The percentage AC6 v1.2 shows, or null when no ceiling is set (no percentage at all).
 * Nearest whole number, and a half goes up (12.5 is 13). Zero spend is "0%". A nonzero share under 1% is "<1%"
 * before rounding, so 0.5 stays "<1%". Over 100% is that same rounded figure (100.40 of 100 is "100%", 113 is "113%").
 * Worked in whole micro-dollars so an exact half is not lost to floating point (0.09 of 0.4 is 22.5, so "23%").
 */
export function percentLabel(spendUsd: number, ceilingUsd: number | null | undefined): string | null {
  if (!hasCeiling(ceilingUsd)) return null;
  if (!(spendUsd > 0)) return "0%";
  const s = Math.round(spendUsd * 1e6);
  const c = Math.round(ceilingUsd * 1e6);
  if (s * 100 < c) return "<1%";
  return `${Math.floor((s * 200 + c) / (2 * c))}%`;
}

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * AC6 v1.2 on the Super Admin's Usage screen, by role and exact text: the spend figures are the terms and definitions of
 * the one description list in `main`, in order. With a ceiling: Spend to date, Monthly ceiling, Percentage used, a meter,
 * and "Over ceiling" exactly when spend is above the ceiling. With none: "No ceiling set", and no percentage, meter or flag.
 */
export async function expectSpend(main: Locator, spendUsd: number, ceilingUsd: number | null | undefined, label: string | null) {
  const meter = main.getByRole("meter", { name: "Spend against the monthly ceiling" });
  const flag = main.getByText(OVER_CEILING, { exact: true });
  await expect(main.getByRole("heading", { name: "Spend against the monthly ceiling", exact: true })).toBeVisible();
  if (label === null) {
    await expect(main.getByRole("term")).toHaveText(["Spend to date", "Monthly ceiling"]);
    await expect(main.getByRole("definition")).toHaveText([usd(spendUsd), NO_CEILING]);
    await expect(meter).toHaveCount(0);
    await expect(flag).toHaveCount(0);
    const text = await main.innerText();
    expect(text, "no percentage when no ceiling is set").not.toContain("%");
    expect(text).not.toMatch(/NaN|Infinity/);
    return;
  }
  const over = spendUsd > (ceilingUsd as number);
  await expect(main.getByRole("term")).toHaveText(["Spend to date", "Monthly ceiling", "Percentage used"]);
  await expect(main.getByRole("definition")).toHaveText([
    usd(spendUsd),
    usd(ceilingUsd as number),
    new RegExp(`^${escape(label)}${over ? ` ${OVER_CEILING}` : ""}$`),
  ]);
  if (over) await expect(flag).toBeVisible();
  else await expect(flag).toHaveCount(0);
  await expect(meter).toHaveAttribute("aria-valuetext", new RegExp(`^${escape(`${usd(spendUsd)} of ${usd(ceilingUsd as number)}, ${label} used`)}`));
  await expect(main).not.toContainText(NO_CEILING);
}

/**
 * A fixed /api/usage payload. Spend is 10 of a ceiling of 80. The stored percent stays 12.5.
 * The screen should show 13%. Quick actions add up to 10. The message total stays 17.
 */
export function sampleUsage(patch: Partial<UsageBody> = {}): UsageBody {
  const spendUsd = 10;
  const ceilingUsd = 80;
  return {
    monthStart: "2026-09-30T18:30:00.000Z", // 1 October 2026, 00:00 India time
    weekStart: "2026-10-11T18:30:00.000Z",
    ceiling: { usd: ceilingUsd, spendUsd, percent: apiPercent(spendUsd, ceilingUsd) },
    month: { calls: 3, inputTokens: 1200, outputTokens: 340, costUsd: 10, messages: 17 },
    quickActions: QUICK_ROWS.map((q) => ({ ...q })),
    people: [{ id: "p1", name: "Asha", monthCalls: 3, weekCalls: 1, monthCostUsd: 10 }],
    chatText: CHAT,
    ...patch,
  };
}

/** 1 February 2099, 00:00 India time. A row from 31 January 23:59:59 IST belongs to the previous month. */
export function freshMonth(): UsageBody {
  const start = monthStartIST(new Date("2099-02-01T00:00:00+05:30"));
  return sampleUsage({
    monthStart: start.toISOString(),
    ceiling: { usd: 100, spendUsd: 0, percent: 0 },
    month: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, messages: 0 },
    quickActions: QUICK_ROWS.map((q) => ({ ...q, count: 0 })),
    people: [],
  });
}

/** Answer GET /api/usage with `data` for the rest of this page. Nothing is written on the server. */
export async function stubUsage(page: Page, data: UsageBody) {
  await page.route((u) => u.pathname === "/api/usage", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) }));
}

export function usageCard(page: Page, heading: string) {
  return page.locator("section.card", { has: page.getByRole("heading", { name: heading, exact: true }) });
}

/** The figure next to a label inside one usage card. Each label sits in its own row. */
export function figure(card: Locator, label: string) {
  return card.locator(".usage-figs > div", { hasText: label }).locator("dd");
}

const BLOCKS = ".usage-h, .usage-figs dt, .usage-figs dd, .usage-count, .usage-split .hint";

/** The page does not scroll sideways, and each usage label and figure sits fully on screen. */
export async function fits(page: Page) {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.page, "document sideways scroll").toBeLessThanOrEqual(1);
  expect(overflow.body, "body sideways scroll").toBeLessThanOrEqual(1);
  const problems = await page.evaluate((sel) => {
    const out: string[] = [];
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || el.className;
      if (r.width < 1 || r.height < 1) out.push(`"${text}" has no box`);
      else if (r.left < -1 || r.right > window.innerWidth + 1) out.push(`"${text}" runs past the screen`);
      return text;
    };
    for (const el of document.querySelectorAll(sel)) {
      const text = box(el);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`"${text}" is cut off`);
    }
    // The meter track is overflow:hidden on purpose. Only its box has to stay on screen.
    for (const el of document.querySelectorAll(".usage-meter")) box(el);
    return out;
  }, BLOCKS);
  expect(problems).toEqual([]);
}

/**
 * Member or Admin: the heading is the refusal, /api/usage is not requested, and no spend, message or
 * quick-action figure is on the page. The API itself answers 404 with no figures.
 */
export async function expectRefused(who: { page: Page; api: Api }) {
  const asked: string[] = [];
  who.page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/usage") asked.push(r.method());
  });
  await who.page.goto("/usage", { waitUntil: "domcontentloaded" });
  await expect(who.page.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  await expect(who.page.getByText("Only the Super Admin can see usage.")).toBeVisible();
  await who.page.waitForTimeout(800); // the client fetch would have started by now
  expect(asked, "the page does not request /api/usage").toEqual([]);
  await expect(who.page.getByRole("heading", { name: "Spend against the monthly ceiling" })).toHaveCount(0);
  await expect(who.page.getByRole("heading", { name: "Messages this month" })).toHaveCount(0);
  await expect(who.page.getByRole("heading", { name: "Quick actions this month" })).toHaveCount(0);
  await expect(who.page.getByRole("meter")).toHaveCount(0);
  await expect(who.page.getByRole("link", { name: "Usage", exact: true })).toHaveCount(0);
  const main = await who.page.locator("main").innerText();
  expect(main).not.toContain("$");
  expect(main).not.toContain(CHAT);
  expect(main).not.toMatch(/\d+(\.\d+)?%/);
  const api = await who.api.get("/api/usage");
  const body = JSON.stringify(api.json);
  expect(api.status, body).toBe(404);
  expect(api.json.error).toBe("Resource not found");
  for (const bit of ["spendUsd", "quickActions", "messages", "ceiling", CHAT]) expect(body, bit).not.toContain(bit);
}
