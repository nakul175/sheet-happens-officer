import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and one process per mode, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes` or `npm run test:stalled-modes`. CI runs the stalled-deal one after the build.
// APL-2733.spec.ts is a Playwright story. Vitest's default include matches *.spec.ts, so it is excluded here.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    exclude: [
      ...configDefaults.exclude,
      "tests/viewport/**",
      "tests/crm-visible-modes-server.test.ts",
      "tests/apl-2713-crm-modes.test.ts",
      "tests/task-outsider-2875-crm.test.ts",
      "tests/jobs-stalled-crm-server.test.ts",
      "e2e/**",
      "scripts/**",
      "tests/e2e/stories/APL-2733.spec.ts",
    ],
  },
});
