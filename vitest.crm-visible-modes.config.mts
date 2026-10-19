import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// APL-2658. One production server per CRM_VISIBLE mode. Not part of `npm test`.
//   npm run test:crm-modes
// CI runs that after the production build (APL-2728 AC4). A missing build fails the file with a message that says so.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/crm-visible-modes-server.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
