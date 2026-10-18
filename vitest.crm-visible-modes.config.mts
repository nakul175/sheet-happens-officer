import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// APL-2658. One production server per CRM_VISIBLE mode. Run on its own with:
//   npx vitest run -c vitest.crm-visible-modes.config.mts
// `npm test` also picks up the file (it lives under tests/). The production build must exist first.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/crm-visible-modes-server.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
