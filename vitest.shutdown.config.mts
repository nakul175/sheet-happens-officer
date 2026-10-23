import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm test` excludes tests/shutdown-next.test.ts because that file runs `next build`
// and would rewrite .next under the server CI already started. This config runs it alone.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    include: ["tests/shutdown-next.test.ts"],
  },
});
