import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Browser tier (npm run test:browser). These 7 files drive a real Chromium through Playwright, and each
// one first-paints routes on the shared dev server, so a single test can legitimately take minutes.
// In the full `npm test` run they shared the machine with 107 other files and 9 of their tests hit the
// 30s testTimeout; run alone they finish in well under a minute. Keep them out of the main config
// (see the exclude list there) so neither tier's timing is decided by the other.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "browser-tier",
    include: [
      "tests/apl-2770-long-assignee.test.ts",
      "tests/e2e/local/APL-2739.test.ts",
      "tests/e2e/stories/APL-2736.spec.ts",
      "tests/activity-delete-undo.test.ts",
      "tests/inline-touch-2673.test.ts",
      "tests/forced-password-23-5-browser.test.ts",
      "tests/e2e/local/APL-2719.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // Same BASE_URL handoff as vitest.config.mts (APL-2917): tests/e2e/base-url.ts reads this one variable.
    env: { SHO_E2E_START_BASE_URL: process.env.BASE_URL ?? "" },
  },
});
