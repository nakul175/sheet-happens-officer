import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
// Explicit selection is required; no managed/staging DB can pass the fixture guards.
export default defineConfig({ ...base, testDir: "./tests/e2e/owned-local", testIgnore: [], outputDir: "test-results/owned-local" });
