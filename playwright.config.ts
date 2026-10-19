import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./tests/e2e/base-url";

// Story-level browser tests (tests/e2e/stories/<issue-id>.spec.ts).
// They run against STAGING by default and read every credential from the environment:
//   STAGING_USER, STAGING_PASS     the basic-auth gate in front of staging
//   SHO_ADMIN_EMAIL, SHO_ADMIN_PASS   a Super Admin account on staging
//   SHO_MEMBER_EMAIL, SHO_MEMBER_PASS   OPTIONAL: a plain Member account. Specs that need a second person skip without it.
//   BASE_URL                       optional, the app under test (default: staging). Production hosts are refused (tests/e2e/base-url.ts).
//   PW_CHROMIUM                    optional path to a Chromium binary
// Nothing here is ever pointed at production. All test data is named "ZZ-TEST ..." and cleaned up by the spec.

export default defineConfig({
  testDir: "./tests/e2e/stories",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "test-results/e2e",
  projects: [
    // Phone stories (forms, the task sheet, the installable app) run on the mobile project.
    // APL-2522.spec.ts is the Vitest spec. The Playwright story is APL-2522-browser.spec.ts.
    { name: "chromium", testIgnore: /APL-2551\.spec\.ts|APL-2555\.spec\.ts|APL-2558\.spec\.ts|APL-2522\.spec\.ts/ },
    { name: "mobile", testMatch: /APL-2551\.spec\.ts|APL-2555\.spec\.ts|APL-2558\.spec\.ts/, use: { ...devices["Pixel 5"] } },
  ],
});
