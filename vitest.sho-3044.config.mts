import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "tests/deal-classification-intake.test.ts",
      "tests/deal-classification-ui.test.tsx",
    ],
    fileParallelism: false,
  },
});
