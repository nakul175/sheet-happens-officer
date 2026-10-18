import { defineConfig } from "@playwright/test";

// Story specs. testMatch stays wide so an explicit path to another story file still runs.
export default defineConfig({
  testDir: "tests/e2e/stories",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.TASKBOARD_URL || process.env.BASE_URL || "http://127.0.0.1:3100",
  },
});
