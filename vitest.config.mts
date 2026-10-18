import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and three processes, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`.
// Phone checks and the production smoke have their own commands.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // scripts/** holds node:test files (assert-playwright-ran.test.mjs). Vitest's default
  // include matches *.test.mjs and fails them with "No test suite found", which blocks deploy.yml.
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      ...configDefaults.exclude,
      "tests/viewport/**",
      "tests/smoke/**",
      "tests/crm-visible-modes-server.test.ts",
      "scripts/**",
    ],
  },
});
