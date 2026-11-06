import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { BASE } from "../helpers";

let browser: Browser;

beforeAll(async () => {
  const host = new URL(BASE).hostname;
  if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error(`Refusing brand checks against ${BASE}`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
});

afterAll(async () => { await browser?.close(); });

describe("Tasks by aplyd public brand", () => {
  for (const width of [390, 1280]) {
    it(`renders the sign-in brand in loaded Lato at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 800 }, baseURL: BASE });
      try {
        const page = await context.newPage();
        const response = await page.goto("/signin");
        expect(response?.status()).toBe(200);
        await expect.poll(() => page.title()).toBe("Sign in · Tasks by aplyd");
        expect(await page.getByText("Tasks by aplyd", { exact: true }).count()).toBeGreaterThan(0);
        const typography = await page.evaluate(async () => {
          await document.fonts.ready;
          return {
            body: getComputedStyle(document.body).fontFamily.toLowerCase(),
            loaded: [...document.fonts].some((font) => font.family.toLowerCase().includes("lato") && font.status === "loaded"),
          };
        });
        expect(typography.body).toContain("lato");
        expect(typography.loaded).toBe(true);
      } finally { await context.close(); }
    });
  }
});
