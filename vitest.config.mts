import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and three processes, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`. Playwright stories and viewport specs have their own runners.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  // APL-2669 is Playwright, so Vitest skips that one file. The APL-2522 files under tests/e2e are Vitest and stay in this run.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "tests/viewport/**", "tests/e2e/stories/APL-2669.spec.ts", "tests/crm-visible-modes-server.test.ts", "e2e/**", "scripts/**"],
  },
});
