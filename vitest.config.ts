import { defineConfig } from "vitest/config";

// Tests hit a live dev server (first request to a route compiles it), so allow time.
export default defineConfig({ test: { testTimeout: 30000, fileParallelism: false } });
