import { defineConfig } from "@playwright/test";

// APL-2681 story spec only. APL-2522.spec.ts in this folder is a Vitest file.
// Point BASE_URL at a local server. Production hosts are refused.
const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const host = (() => {
  try { return new URL(BASE_URL).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; }
})();
const PRODUCTION = ["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"];
if (!host) throw new Error("BASE_URL is not a URL");
if (PRODUCTION.includes(host)) throw new Error(`Refusing to run story tests against production (${host}).`);

export default defineConfig({
  testDir: "./tests/e2e/stories",
  testMatch: "APL-2681.spec.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: process.env.PW_VIEWPORT === "390x844" ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "test-results/e2e",
});
