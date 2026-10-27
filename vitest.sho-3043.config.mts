import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/deal-date-filter.test.ts", "tests/deal-lifecycle-ui.test.tsx", "tests/deal-classification-intake.test.ts"], fileParallelism: false },
});
