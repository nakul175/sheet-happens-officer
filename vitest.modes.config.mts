import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// SHO-2881. Every per-mode server test uses this suffix, so new files join the
// dedicated post-build CI loop without another config or workflow edit.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.mode.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
