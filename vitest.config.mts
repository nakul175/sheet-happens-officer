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
      // SHO-2625 must exercise the exact sho_staging DB guard in its dedicated seeded tier.
      "tests/purge-zz-test.test.ts",
      "tests/purge-zz-test-cascade.test.ts",
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
      "tests/e2e/stories/**", // every file here is a Playwright story, not Vitest (see the note at the top)
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
      // Browser tier: 8 Playwright/Chromium files that compete with these 107 files for the dev server and the
      // machine, and lost 9 tests to the 30s testTimeout in the full run. They have their own config and
      // their own npm script (`npm run test:browser`, vitest.browser-tier.config.mts, testTimeout 120s).
      "tests/apl-2770-long-assignee.test.ts",
      "tests/e2e/local/APL-2739.test.ts",
      "tests/e2e/stories/APL-2736.spec.ts",
      "tests/activity-delete-undo.test.ts",
      "tests/inline-touch-2673.test.ts",
      "tests/forced-password-23-5-browser.test.ts",
      "tests/e2e/local/APL-2719.test.ts",
      "tests/e2e/local/SHO-2738-3025-3030.browser.test.ts",
      // SIGTERM drain (APL-2688 / APL-2689). tests/shutdown-next.test.ts is Linux-only whole, and
      // `npm test` collected it anyway until W152 (its own header said the opposite), so `npm test`
      // on darwin went red for a reason that had nothing to do with the change under test: it spawns
      // `taskset`, reads /proc/<pid>/status and /proc/<pid>/limits, and runs `next build`, which
      // would rewrite .next under the app the CI job already started at :3100.
      //   * tests/shutdown.test.ts is NOT excluded. Only seven of its cases are Linux-only (they
      //     assert exit 0 and CLEAN_LOG, which src/lib/shutdown.ts produces only where the Linux
      //     accept-queue seizer loaded; loadNative/loadLibc return null off linux, :205 and :246),
      //     and those seven gate themselves with `it.skipIf(process.platform !== "linux")` plus a
      //     reason on the title. W152 excluded the whole file instead, which bought a green darwin
      //     run by dropping the clock/env, module-identity, timeout-path and F7 cases from `npm test`
      //     as well; W163 put them back.
      // The Linux tier is vitest.shutdown.config.mts, which ci.yml runs on ubuntu-latest before the
      // app starts; it names both files, so the seven skipped-off cases still run there. Named one by
      // one, not a glob, so a new file here still lands in this run.
      // tests/tier-placement.test.ts asserts both halves of that placement.
      "tests/shutdown-next.test.ts",
    ],
  },
});
