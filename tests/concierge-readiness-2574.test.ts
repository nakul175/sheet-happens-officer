// APL-2574 regression: a visible landmark with delayed state is not an enabled concierge.
// This browser-only timing proof sends no HTTP/provider requests and makes no product AI acceptance claim.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { settledConciergeContent } from "./e2e/helpers/concierge-readiness";
let browser: Browser;
beforeAll(async () => {
  const candidates = [process.env.PW_CHROMIUM, "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter((p): p is string => !!p);
  const executablePath = candidates.find(p => existsSync(p));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
afterAll(async () => { await browser?.close(); });

it("waits for delayed disabled reason instead of asserting chips during loading", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<aside aria-label="Concierge"><p>Loading…</p><div role="group" aria-label="Quick actions"><button disabled>Show overdue here</button><button disabled>Blocked here</button></div></aside>');
    const panel = page.getByRole("complementary", { name: "Concierge" });
    expect(await panel.isVisible()).toBe(true);
    expect(await panel.locator(".cc-disabled").isVisible()).toBe(false); // old immediate check misclassified this state
    let settled = false;
    const pending = settledConciergeContent(panel).then(result => { settled = true; return result; });
    await page.waitForTimeout(100);
    expect(settled).toBe(false);
    await page.evaluate(() => { document.querySelector("aside")!.innerHTML = '<div class="cc-disabled">The concierge is not switched on yet.</div>'; });
    expect(await pending).toEqual({ kind: "disabled", reason: "The concierge is not switched on yet." });
  } finally { await page.close(); }
});
it("waits for delayed enabled chips and preserves project-chip assertions", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<aside aria-label="Concierge"><p>Loading…</p><div role="group" aria-label="Quick actions"><button disabled>Show overdue here</button><button disabled>Blocked here</button></div></aside>');
    const panel = page.getByRole("complementary", { name: "Concierge" });
    let settled = false;
    const pending = settledConciergeContent(panel).then(result => { settled = true; return result; });
    await page.waitForTimeout(100);
    expect(settled).toBe(false);
    await page.evaluate(() => { document.querySelector("aside")!.innerHTML = '<div role="group" aria-label="Quick actions"><button>Show overdue here</button><button>Blocked here</button></div>'; });
    const result = await pending;
    expect(result.kind).toBe("ready");
    expect(await panel.getByRole("button", { name: "Show overdue here" }).isVisible()).toBe(true);
    expect(await panel.getByRole("button", { name: "Blocked here" }).isVisible()).toBe(true);
  } finally { await page.close(); }
});
