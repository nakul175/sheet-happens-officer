// Local test database only. Exercise real routing/session behavior after the Shell lint fixes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, PW, superAdmin, type Account } from "../helpers";

let browser: Browser;
let person: Account;

beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname)) {
    throw new Error("SHO-2666 Shell regressions require a local test server.");
  }
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  person = await account("shell2666", `nakul17+zz-shell-2666-${Date.now()}@aplyd.com`, "ZZ-TEST Shell 2666");
});

afterAll(async () => {
  try {
    if (person) {
      const root = await superAdmin();
      try {
        expect((await root.c.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      } finally { await root.c.post("/api/auth/signout"); }
    }
  } finally { await browser?.close(); }
});

async function signedIn(width: number) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 844 } });
  ctx.setDefaultTimeout(15_000);
  ctx.setDefaultNavigationTimeout(15_000);
  try {
    const signed = await ctx.request.post("/api/auth/signin", { data: { email: person.email, password: PW } });
    expect(signed.status()).toBe(200);
    const page = await ctx.newPage();
    await page.goto("/projects");
    await page.locator("main#main").waitFor();
    return { ctx, page };
  } catch (error) {
    await ctx.close();
    throw error;
  }
}

describe("SHO-2666 Shell", () => {
  it("dismisses More with Escape/outside click and keeps handlers correct after navigation", async () => {
    const { ctx, page } = await signedIn(390);
    try {
      const more = page.getByRole("button", { name: "More", exact: true });
      const menu = page.getByRole("menu", { name: "More", exact: true });
      await more.click();
      await menu.waitFor();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await more.click();
      await menu.waitFor();
      await page.locator("main h1").click();
      await menu.waitFor({ state: "detached" });
      await more.click();
      await page.getByRole("menuitem", { name: "Team", exact: true }).click();
      await page.waitForURL("**/team");
      await menu.waitFor({ state: "detached" });
      await more.click();
      await menu.waitFor();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      expect(await more.getAttribute("aria-expanded")).toBe("false");
    } finally { await ctx.close(); }
  });

  for (const width of [390, 1280]) {
    it(`keeps logo sizing and signs out through the ${width === 390 ? "More menu" : "profile button"} at ${width}px`, async () => {
      const { ctx, page } = await signedIn(width);
      try {
        const previousCookie = (await ctx.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        const logo = page.locator(".top-brand img");
        await logo.waitFor({ state: "visible" });
        expect(await logo.getAttribute("src")).toBe("/logo-icon-reversed.svg");
        expect(await logo.getAttribute("alt")).toBe("");
        const size = width === 390 ? 28 : 36;
        expect(await logo.evaluate((img) => {
          const rect = img.getBoundingClientRect();
          return { width: rect.width, height: rect.height, loaded: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0 };
        })).toEqual({ width: size, height: size, loaded: true });

        if (width === 390) {
          await page.getByRole("button", { name: "More", exact: true }).click();
          await page.getByRole("menuitem", { name: "Team", exact: true }).click();
          await page.waitForURL("**/team");
          await page.getByRole("button", { name: "More", exact: true }).click();
        } else {
          await page.getByRole("button", { name: /^Account and utilities,/ }).click();
          await page.locator(".account-options").getByRole("link", { name: "Profile", exact: true }).click();
          await page.waitForURL("**/profile");
          await page.getByRole("button", { name: /^Account and utilities,/ }).click();
        }
        const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/auth/signout");
        if (width === 390) await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
        else await page.locator(".account-options").getByRole("button", { name: "Sign out", exact: true }).click();
        const signedOut = await response;
        expect(signedOut.status()).toBe(204);
        expect(new URL(signedOut.url()).pathname).toBe("/api/auth/signout");
        await page.waitForURL(/\/signin(?:\?|$)/);
        // Next preserves inactive page DOM with cacheComponents; it must stay hidden and inaccessible.
        await page.locator(".shell").waitFor({ state: "hidden" });
        expect((await ctx.request.get("/api/auth/me")).status()).toBe(401);
        // Verify revocation too, independently of the browser deleting its cookie.
        expect((await fetch(`${BASE}/api/auth/me`, { headers: { cookie: previousCookie } })).status).toBe(401);
        await page.goBack();
        // A previously visited private route must be rejected after the session is gone.
        await page.waitForURL(/\/signin(?:\?|$)/);
        // Next preserves inactive page DOM with cacheComponents; it must stay hidden and inaccessible.
        await page.locator(".shell").waitFor({ state: "hidden" });
        await page.goto("/projects");
        await page.waitForURL(/\/signin(?:\?|$)/);
        expect(await page.locator(".shell:visible").count()).toBe(0);
      } finally { await ctx.close(); }
    });
  }
});
