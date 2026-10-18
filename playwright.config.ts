import { defineConfig } from "@playwright/test";
import { assertProdHostGuard } from "./deploy/prod-host-guard.cjs";

// Runs before any test. Production requires an exact @readonly grep (-g or --grep)
// and an exact @write grep-invert (-G or --grep-invert).
assertProdHostGuard(process.argv, process.env);

const baseURL = process.env.BASE_URL || process.env.TASKBOARD_URL || "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  reporter: "list",
  use: { baseURL },
});
