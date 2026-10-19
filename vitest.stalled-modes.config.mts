import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// APL-2741. One production server per CRM_VISIBLE mode. Not part of `npm test`.
//   npm run test:stalled-modes
// Requires `npm run build` first. A missing build fails the file. CI runs this after the build.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/jobs-stalled-crm-server.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
