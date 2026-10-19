import { defineConfig } from "@playwright/test";

// Story specs in tests/e2e/stories. APL-2522.spec.ts and APL-2609.spec.ts are Vitest files (APL-2609 starts one server per
// CRM_VISIBLE mode and runs in `npm run test:crm-modes`), so Playwright ignores them.
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
  testIgnore: ["**/APL-2522.spec.ts", "**/APL-2609.spec.ts"],
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
