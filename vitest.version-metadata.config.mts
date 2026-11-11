import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only the APL-2648 Playwright parent supplies this disposable task fixture.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/e2e/named/task-version-metadata.ts"], testTimeout: 30000, fileParallelism: false },
});
