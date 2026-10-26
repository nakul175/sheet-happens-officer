import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "tests/bid-stage-lifecycle.test.ts",
      "tests/bid-stage-migration-intake.test.ts",
      "tests/deal-lifecycle-route.test.ts",
      "tests/deal-lifecycle-ui.test.tsx",
      "tests/review-commercial-counts.test.tsx",
    ],
    fileParallelism: false,
  },
});
