import { defineConfig } from "@playwright/test";

// Story-level browser tests (tests/e2e/stories/<issue-id>.spec.ts).
// They run against STAGING by default and read every credential from the environment:
//   STAGING_USER, STAGING_PASS     the basic-auth gate in front of staging
//   SHO_ADMIN_EMAIL, SHO_ADMIN_PASS   a Super Admin account on staging
//   SHO_MEMBER_EMAIL, SHO_MEMBER_PASS   OPTIONAL: a plain Member account. Specs that need a second person skip without it.
//   STAGING_URL                    optional, defaults to https://staging.sheethappensofficer.com
//   PW_CHROMIUM                    optional path to a Chromium binary
// Nothing here is ever pointed at production. All test data is named "ZZ-TEST ..." and cleaned up by the spec.
const url = process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com";
if (/^https?:\/\/app\.sheethappensofficer\.com/.test(url)) throw new Error("Refusing to run story tests against production.");

export default defineConfig({
  testDir: "./tests/e2e/stories",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: url,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "test-results/e2e",
});
