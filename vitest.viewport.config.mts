import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// SHO-US-10.11: the phone-size suite runs on its own (npm run test:viewport); `npm test` skips it because it needs a browser.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/viewport/**/*.test.ts"], testTimeout: 60000, hookTimeout: 90000, fileParallelism: false },
});
