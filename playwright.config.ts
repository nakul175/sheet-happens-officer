import { defineConfig } from "@playwright/test";
import { assertProdHostGuard } from "./deploy/prod-host-guard.mjs";

// Runs before any test. Production requires --grep @readonly and --grep-invert @write.
assertProdHostGuard(process.argv, process.env);

const baseURL = process.env.BASE_URL || process.env.TASKBOARD_URL || "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  reporter: "list",
  use: { baseURL },
});
