import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
// The concierge tests also call src/lib directly (the "@/..." imports), with a fake model.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    // shutdown-next.test.ts runs `next build` and would rewrite .next under a live server.
    exclude: [...configDefaults.exclude, "tests/viewport/**", "tests/shutdown-next.test.ts"],
  },
});
