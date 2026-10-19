import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./tests/e2e/base-url";
// Every story spec that imports vitest. scripts/ci/story-specs-no-vitest.test.mjs checks the rest against this same list.
import { VITEST_SPECS } from "./tests/e2e/vitest-specs.cjs";

// Story-level browser tests (tests/e2e/stories/<issue-id>.spec.ts).
// They run against the LOCAL server (http://localhost:3100) unless a target is set, and read every credential from the environment:
//   STAGING_USER, STAGING_PASS     the basic-auth gate in front of staging
//   SHO_ADMIN_EMAIL, SHO_ADMIN_PASS   a Super Admin account on staging
//   SHO_MEMBER_EMAIL, SHO_MEMBER_PASS   a plain Member account. A spec that needs a second person fails without it (support.ts).
//   BASE_URL / TASKBOARD_URL / STAGING_URL   the app under test, in that order (default: http://localhost:3100).
//                                  staging-e2e.yml sets BASE_URL for staging. Production hosts are refused (tests/e2e/base-url.ts).
//   PW_CHROMIUM                    optional path to a Chromium binary
// Nothing here is ever pointed at production. All test data is named "ZZ-TEST ..." and cleaned up by the spec.

export default defineConfig({
  // Discovery stays inside tests/e2e: only *.spec.ts under tests/e2e/stories, minus the Vitest specs (above).
  testDir: "./tests/e2e/stories",
  testMatch: "**/*.spec.ts",
  testIgnore: VITEST_SPECS,
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
});
