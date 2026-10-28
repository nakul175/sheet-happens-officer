// APL-2741. The bell paints a stalled-deal notice (deal name and /projects/<id> link) in a real browser.
// The job runs here, in this process, with each CRM_VISIBLE mode. The bell is read in Chromium from the
// local server (TASKBOARD_URL), which runs with CRM_VISIBLE unset so it paints every stored row.
// qa:TC missing: QA has not assigned TC ids for this story yet.
// Local only, workers=1 (vitest.e2e.config.mts). ZZ-TEST deals, nakul17+ aliases. Run: npm run test:e2e
// The job sends no email; the outbox is still checked.
import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { expect as browserExpect } from "@playwright/test";
import { notifyStalledDeals } from "@/lib/deals";
import { BASE, type Account } from "../tests/helpers";
import {
  assertLocalTestDatabase,
  cleanupStalledWorld,
  dealNeedles,
  expectNoDealMail,
  seedStalledWorld,
  type DealFix,
  type Mode,
  type StalledWorld,
} from "../tests/stalled-crm-fixture";

let browser: Browser;
let world: StalledWorld;

async function withMode(mode: Mode, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  if (mode === "unset") delete process.env.CRM_VISIBLE;
  else process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

/**
 * Opens the bell for `who` in a fresh browser context and returns the panel's text and links.
 * The context reuses each fixture session, including the configured bootstrap Super Admin.
 * Setup notices were marked read through their recipient API; Unread contains the new job notices.
 */
async function openBell(who: Account) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
  try {
    const [name, ...rest] = who.c.cookie.split("=");
    expect(name, `${who.email} has a session`).toBe("sho_session");
    await ctx.addCookies([{ name, value: rest.join("="), url: BASE }]);
    const page = await ctx.newPage();
    // The bell's first /api/notifications load runs in an effect, so it only starts once the page has hydrated.
    // Clicking the server-rendered button before then does nothing (QA D1: dev server timeouts on the dialog).
    const hydrated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/notifications", { timeout: 120000 });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await hydrated;
    const button = page.getByRole("button", { name: /^Notifications\b/ });
    await button.waitFor({ state: "visible", timeout: 120000 });
    await button.click();
    await browserExpect(button).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await panel.waitFor({ state: "visible", timeout: 15000 });
    const unreadResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/notifications" && url.searchParams.get("filter") === "unread";
    });
    await panel.getByRole("button", { name: /^Unread\b/ }).click();
    const response = await unreadResponse;
    expect(response.status()).toBe(200);
    const data = await response.json() as { items: { id: string }[] };
    if (data.items.length) {
      await expect.poll(() => panel.getByRole("button", { name: /^Mark as read:/ }).count()).toBe(data.items.length);
    } else await browserExpect(panel.getByText("All caught up", { exact: true })).toBeVisible();
    const text = await panel.innerText();
    const links = await panel.getByRole("link").evaluateAll(els =>
      els.map(el => ({ href: el.getAttribute("href"), text: el.textContent ?? "" })));
    return { text, links };
  } finally {
    await ctx.close();
  }
}

async function expectBellShows(who: Account, deal: DealFix) {
  const { links } = await openBell(who);
  const mine = links.filter((l) => l.href === `/projects/${deal.id}`);
  expect(mine, `${who.email} bell links to ${deal.name}`).toHaveLength(1);
  expect(mine[0].text).toContain(`"${deal.name}" has had no activity for 30 days.`);
  expect(mine[0].text).not.toContain(deal.title);
}

async function expectBellSilent(who: Account) {
  const { text, links } = await openBell(who);
  const hrefs = JSON.stringify(links);
  for (const needle of dealNeedles(world)) {
    expect(text, `${who.email} bell text ${needle}`).not.toContain(needle);
    expect(hrefs, `${who.email} bell link ${needle}`).not.toContain(needle);
  }
}

describe("qa:TC missing APL-2741 stalled-deal bell in the browser", () => {
  beforeAll(async () => {
    if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
      throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
    }
    assertLocalTestDatabase();
    browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM || "/usr/local/bin/google-chrome",
      args: ["--no-sandbox"],
    });
  }, 180000);

  beforeEach(async () => { world = undefined!; world = await seedStalledWorld(); }, 60_000);
  afterEach(async () => { await cleanupStalledWorld(world); });

  afterAll(async () => {
    await browser?.close();
  });

  it("qa:TC missing AC2: unset, the bell shows today's stalled-deal sentence and link to the owner and admins", async () => {
    await withMode("unset", async () => { expect((await notifyStalledDeals()).notified).toBeGreaterThanOrEqual(1); });
    await expectBellShows(world.owner, world.owned);
    await expectBellShows(world.orgAdmin, world.adminDeal);
    await expectBellShows(world.superLead, world.rootDeal);
    await expectBellSilent(world.follower);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC2: CRM_VISIBLE=all, the bell matches unset", async () => {
    await withMode("all", async () => { await notifyStalledDeals(); });
    await expectBellShows(world.owner, world.owned);
    await expectBellShows(world.orgAdmin, world.adminDeal);
    await expectBellShows(world.superLead, world.rootDeal);
    await expectBellSilent(world.follower);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1 AC2: admins, a non-admin owner or follower sees no deal name, id or link, and admins still do", async () => {
    await withMode("admins", async () => { await notifyStalledDeals(); });
    await expectBellSilent(world.owner);
    await expectBellSilent(world.follower);
    await expectBellShows(world.orgAdmin, world.adminDeal);
    await expectBellShows(world.superLead, world.rootDeal);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1: CRM_VISIBLE=off, no bell names a ZZ-TEST stalled deal", async () => {
    await withMode("off", async () => {
      expect(await notifyStalledDeals()).toEqual({ stalled: 0, notified: 0, skipped: true });
    });
    for (const who of [world.owner, world.follower, world.orgAdmin, world.superLead]) await expectBellSilent(who);
    expectNoDealMail(dealNeedles(world));
  });
});
