import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Local Playwright check for APL-2663. `npm test` skips it (it needs a browser and a local server).
// workers=1: one file, no parallel workers, so the ZZ-TEST projects are not created twice.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["e2e/**/*.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
