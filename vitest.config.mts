import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and three processes, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`.
// Playwright story specs live under tests/e2e/stories and are run with `npx playwright test`, not vitest.
// Vitest's default include matches *.spec.ts, and Vite sets process.env.BASE_URL, which those files refuse.
// APL-2522.spec.ts is the Vitest spec (APL-2712) and stays in the run.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  // tests/e2e/stories is Playwright, except APL-2522.spec.ts.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    exclude: [
      ...configDefaults.exclude,
      "tests/viewport/**",
      "tests/e2e/stories/**",
      "!tests/e2e/stories/APL-2522.spec.ts",
      "e2e/**",
      "tests/crm-visible-modes-server.test.ts",
      "scripts/**",
    ],
  },
});
