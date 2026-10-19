import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// APL-2658, APL-2713 and APL-2609. One production server per CRM_VISIBLE mode. Not part of `npm test`.
//   npm run test:crm-modes
// Requires `npm run build` first, and Playwright Chromium for APL-2609 (PW_CHROMIUM locally). A missing build fails the file with a message that says so.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/crm-visible-modes-server.test.ts", "tests/apl-2713-crm-modes.test.ts", "tests/e2e/local/APL-2609.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
