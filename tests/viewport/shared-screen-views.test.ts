// SHO-2594: exercise saved-view tabs and URL hydration in the real browser at desktop/phone widths.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, cleanupZz, PW, superAdmin, type Account } from "../helpers";
let browser: Browser, owner: Account, peer: Account;
const prefix = `SV ${Date.now()}`;
const shared: { id: string; screen: string; path: string; name: string }[] = [];
beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error("Saved view browser tests require the local test server.");
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  owner = await superAdmin(); peer = await account("zzviewbrowser");
  for (const [screen, path] of [["DEALS", "/deals"], ["ACCOUNTS", "/accounts"], ["REVIEW", "/review"]]) {
    const name = `${prefix} ${screen}`;
    const r = await owner.c.post("/api/screen-views", { name, screen, scope: "WORKSPACE", state: screen === "ACCOUNTS" ? { q: "ZZ", country: "India" } : { atRisk: true } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    shared.push({ id: r.json.view.id, screen, path, name });
  }
}, 60000);
afterAll(async () => {
  await browser?.close();
  for (const view of shared) expect((await owner.c.del(`/api/screen-views/${view.id}?confirmShared=true`)).status).toBe(204);
  if (peer) {
    const remaining = await peer.c.get("/api/screen-views?screen=ACCOUNTS");
    for (const view of remaining.json?.views ?? []) if (view.owner.id === peer.id && view.name.startsWith(prefix)) expect((await peer.c.del(`/api/screen-views/${view.id}?confirmShared=true`)).status).toBe(204);
    await cleanupZz([], [peer]);
  }
});
for (const width of [1280, 390]) it(`SHO-2594 shared tabs apply current filters and allow personal save at ${width}px`, async () => {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
  expect((await context.request.post("/api/auth/signin", { data: { email: peer.email, password: PW } })).ok()).toBe(true);
  const page = await context.newPage();
  const privateIds: string[] = [];
  try {
    for (const view of shared) {
      await page.goto(view.path);
      const tab = page.getByRole("link", { name: `${view.name} · ${owner.name}`, exact: true });
      await tab.waitFor({ state: "visible" }); await tab.click();
      await page.waitForURL(url => url.searchParams.get("view") === view.id || (view.screen === "DEALS" && url.searchParams.get("atRisk") === "true"));
      if (view.screen === "ACCOUNTS") {
        await expect.poll(() => page.getByRole("textbox", { name: "Search organisations", exact: true }).inputValue()).toBe("ZZ");
        expect(await page.getByLabel("Country", { exact: true }).inputValue()).toBe("India");
      } else await expect.poll(() => page.getByRole("checkbox", { name: "At risk", exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole("button", { name: `Edit view ${view.name}`, exact: true }).count()).toBe(0);
    }
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    const name = `${prefix} mine ${width}`;
    await page.getByRole("textbox", { name: "View name", exact: true }).fill(name);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("link", { name, exact: true }).waitFor({ state: "visible" });
    const list = await peer.c.get("/api/screen-views?screen=ACCOUNTS");
    const saved = list.json.views.find((v: { name: string }) => v.name === name);
    privateIds.push(saved.id); expect(saved.scope).toBe("PRIVATE");
    await page.reload(); await page.getByRole("link", { name, exact: true }).waitFor({ state: "visible" });
  } catch (error) {
    mkdirSync("test-results/viewport", { recursive: true });
    await page.screenshot({ path: `test-results/viewport/shared-views-${width}.png`, fullPage: true });
    throw error;
  } finally {
    for (const id of privateIds) expect((await peer.c.del(`/api/screen-views/${id}`)).status).toBe(204);
    await context.close();
  }
}, 60000);
