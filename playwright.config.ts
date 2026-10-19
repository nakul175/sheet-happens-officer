import { defineConfig } from "@playwright/test";

// Story specs in tests/e2e/stories. Files there use @playwright/test only: one vitest import makes the whole run collect 0 tests
// (APL-2761). Vitest suites that drive a local server live in tests/e2e/local and run under `npm test`.
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
  // Vitest suites still in tests/e2e/stories, until APL-2883 moves them to tests/e2e/local. Without these entries Playwright
  // fails to load them and collects 0 tests. scripts/ci/story-specs-no-vitest.test.mjs reads this list: add none.
  testIgnore: [
    "**/APL-2624.spec.ts",
    "**/APL-2694.spec.ts",
    "**/APL-2721.spec.ts",
    "**/APL-2737.spec.ts",
    "**/APL-2742.spec.ts",
  ],
  timeout: 60_000,
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
