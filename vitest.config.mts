import { fileURLToPath } from "node:url";
import { configDefaults as vitestDefaults, defineConfig } from "vitest/config";

// Playwright story specs live under tests/e2e and run from the staging workflow, not vitest.
// The local name stays `configDefaults` so the exclude list below can keep its shape.
const configDefaults = {
  ...vitestDefaults,
  exclude: [...vitestDefaults.exclude, "tests/e2e/**"],
};

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
// CRM_VISIBLE mode servers need a production build and three processes, so they stay out of `npm test`.
// Run them with `npm run test:crm-modes`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "tests/viewport/**", "tests/crm-visible-modes-server.test.ts"],
  },
});
