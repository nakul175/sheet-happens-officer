import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and three processes, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`.
// Playwright story specs are tests/e2e/**/*.spec.ts and are run with `npx playwright test`, not vitest.
// Vitest's default include matches *.spec.ts, and Vite sets process.env.BASE_URL, which those files refuse.
// Vitest story specs from main (APL-2522, 2655, 2679, 2714, 2739) run here; every other tests/e2e spec is Playwright
// and stays out of this run. playwright.config.ts ignores the same five.
// APL-2733.spec.ts is a Playwright story. Vitest's default include matches *.spec.ts, so it is excluded here.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  // tests/e2e/** is Playwright. The same default include matches *.spec.ts, and Vite sets
  // process.env.BASE_URL, which those files refuse.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "tests/viewport/**", "tests/e2e/**/!(APL-2522|APL-2655|APL-2679|APL-2714|APL-2739).spec.ts", "tests/e2e/stories/APL-2522-*.spec.ts", "e2e/**", "tests/crm-visible-modes-server.test.ts", "tests/apl-2713-crm-modes.test.ts", "scripts/**", "tests/e2e/stories/APL-2733.spec.ts"],
  },
});
