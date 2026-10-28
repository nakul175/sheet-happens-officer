import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and one process per mode, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`, `npm run test:reminder-modes` or `npm run test:stalled-modes`. CI runs all three after the build.
// APL-2669.spec.ts, APL-2670.spec.ts, APL-2733.spec.ts, APL-2609.spec.ts, APL-2720.spec.ts, APL-2694.spec.ts, APL-2674.spec.ts, APL-2471.spec.ts, APL-2748.spec.ts, APL-2624.spec.ts, APL-2721.spec.ts and APL-2737.spec.ts are Playwright stories. Vitest's default include matches *.spec.ts, so they are excluded here.
// APL-2917. Vitest rewrites BASE_URL to "/" in the test workers. This file runs first, so it hands the starting value to
// tests/e2e/base-url.ts as SHO_E2E_START_BASE_URL ("" when unset). Only that one variable is copied.
const startBaseUrl = process.env.BASE_URL ?? "";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  // APL-2669 and APL-2670 are Playwright, so Vitest skips those files. The APL-2522 files under tests/e2e are Vitest and stay in this run.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    env: { SHO_E2E_START_BASE_URL: startBaseUrl },
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e/stories/APL-2466.spec.ts", // SHO-2906: Playwright story
      "tests/e2e/stories/APL-2480.spec.ts", // SHO-2906: Playwright story
      "tests/e2e/stories/APL-2482.spec.ts", // SHO-2906: Playwright story
      "tests/e2e/stories/APL-2484.spec.ts", // SHO-2906: Playwright story

      "tests/e2e/stories/APL-2555.spec.ts", // SHO-2905: migrated Playwright story
      "tests/viewport/**",
      "tests/e2e/stories/APL-2669.spec.ts",
      "tests/e2e/stories/APL-2670.spec.ts",
      "tests/e2e/stories/APL-2733.spec.ts",
      "tests/crm-visible-modes-server.test.ts",
      "tests/apl-2713-crm-modes.test.ts",
      "tests/task-outsider-2875-crm.test.ts",
      "tests/jobs-reminders-crm-server.test.ts",
      "tests/jobs-stalled-crm-server.test.ts",
      "tests/e2e/local/APL-2728.test.ts",
      "tests/e2e/stories/APL-2735.spec.ts",
      "tests/e2e/local/APL-2609.spec.ts",
      "e2e/**",
      "scripts/**",
      "tests/e2e/stories/APL-2590.spec.ts", // a Playwright story (APL-2590)
      "tests/e2e/stories/APL-2609.spec.ts",
      "tests/e2e/stories/APL-2720.spec.ts",
      "tests/e2e/stories/APL-2694.spec.ts",
      "tests/e2e/stories/APL-2471.spec.ts",
      "tests/e2e/stories/APL-2748.spec.ts",
      "tests/e2e/stories/APL-2674.spec.ts",
      "tests/e2e/stories/APL-2742.spec.ts",
      "tests/e2e/stories/APL-2624.spec.ts",
      "tests/e2e/stories/APL-2721.spec.ts",
      "tests/e2e/stories/APL-2737.spec.ts",
      "tests/e2e/stories/APL-2559.spec.ts",
      "tests/e2e/stories/APL-2608.spec.ts",
    ],
  },
});
