import { defineConfig } from "@playwright/test";

// Story specs for the staging workflow (tests/e2e/stories). APL-2669 talks to the API only.
export default defineConfig({
  testDir: "tests/e2e/stories",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? process.env.TASKBOARD_URL ?? "http://localhost:3100",
  },
});
