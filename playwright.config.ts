import { defineConfig } from "@playwright/test";

// Story specs in tests/e2e/stories. APL-2522.spec.ts on this branch is a Vitest file, so Playwright ignores it.
// workers=1. BASE_URL or TASKBOARD_URL points at the app. Production hosts are refused.
// Default is localhost: Next dev does not hydrate the sign-up form when the page is opened as 127.0.0.1.
const baseURL = (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");

const host = (() => {
  try {
    return new URL(baseURL).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
})();

const PRODUCTION = new Set([
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
  "app.sheethappensofficer.com",
  "168.144.144.69",
]);

if (PRODUCTION.has(host)) throw new Error(`Refusing to run story tests against production (${host}).`);

export default defineConfig({
  testDir: "./tests/e2e/stories",
  testIgnore: ["**/APL-2522.spec.ts"],
  timeout: 120_000, // APL-2590's spec seeds several roles per test
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : undefined,
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "test-results/e2e",
});
