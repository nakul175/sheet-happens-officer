import { defineConfig } from "@playwright/test";

// Release-gate browser tests (tests/e2e/smoke). Separate from playwright.config.ts so the
// story suite's production refusal does not block a later @readonly pass against production.
// @write tests refuse any host that is not staging (tests/e2e/smoke/guard.ts) before they sign in.
// An unset BASE_URL stays on localhost, so this file never reaches staging or production by default.
const baseURL = (process.env.BASE_URL || process.env.STAGING_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

export default defineConfig({
  testDir: "./tests/e2e/smoke",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/smoke-report.json" }]],
  use: {
    baseURL,
    viewport: { width: 1400, height: 900 },
    httpCredentials: process.env.STAGING_USER
      ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" }
      : undefined,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "test-results/smoke",
});
