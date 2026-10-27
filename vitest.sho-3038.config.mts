import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "tests/workspace-task-membership.test.ts",
      "tests/workspace-task-person-ui.test.tsx",
    ],
    fileParallelism: false,
  },
});
