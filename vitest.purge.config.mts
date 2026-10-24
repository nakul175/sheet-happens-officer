import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/purge-zz-test.test.ts", "tests/purge-zz-test-cascade.test.ts", "tests/purge-guards-2625.test.ts"], fileParallelism: false, testTimeout: 30000 },
});
