// Isolated local database only; no provider and no business writes from the chip.
import { beforeAll, afterAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, PW, superAdmin, type Account } from "../../helpers";
let browser: Browser;
let person: Account;
beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname)) throw Error("Local test server required");
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/usr/bin/google-chrome" });
  person = await account("attention2584");
});
afterAll(async () => {
  try { if (person) { const root = await superAdmin(); expect((await root.c.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" })).status).toBe(200); } }
  finally { await browser?.close(); }
});
for (const width of [1280, 390]) it(`SHO-2584: deterministic attention chip works without a provider at ${width}px`, async () => {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 } });
  try {
    expect((await ctx.request.post("/api/auth/signin", { data: { email: person.email, password: PW } })).status()).toBe(200);
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await page.goto("/");
    const chip = page.getByRole("button", { name: "Deals needing attention", exact: true }).filter({ visible: true });
    if (width >= 1280) {
      await page.getByRole("button", { name: /^Account and utilities,/ }).click();
      await page.getByRole("button", { name: "Open Concierge", exact: true }).click();
    }
    else {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Concierge", exact: true }).click();
    }
    await chip.waitFor();
    expect(await chip.isEnabled()).toBe(true);
    const response = page.waitForResponse(r => r.url().endsWith("/api/concierge/quick/deals-attention") && r.request().method() === "POST");
    await chip.click();
    const reply = await response;
    expect(reply.status()).toBe(200);
    const body = await reply.json();
    expect(body.messages.at(-1).text).toContain("I found nothing.");
    await page.getByText("I found nothing.", { exact: false }).last().waitFor();
    expect(await page.locator(".cc-card").count()).toBe(0);
    await page.screenshot({ path: `test-results/sho-2584-${width}.png`, fullPage: true });
  } finally { await ctx.close(); }
});
