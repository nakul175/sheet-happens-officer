import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// APL-2658, APL-2713, APL-2728 and APL-2875. One production server per CRM_VISIBLE mode. Not part of `npm test`.
//   npm run test:crm-modes
// CI runs that after the production build (APL-2728 AC4). A missing build fails the file with a message that says so.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/crm-visible-modes-server.test.ts", "tests/apl-2713-crm-modes.test.ts", "tests/e2e/stories/APL-2728.spec.ts", "tests/task-outsider-2875-crm.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
