import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Story specs are Playwright tests. Vite rewrites process.env.BASE_URL, so Vitest cannot load them.
  test: { testTimeout: 30000, fileParallelism: false, exclude: [...configDefaults.exclude, "tests/viewport/**", "tests/e2e/**"] },
});
