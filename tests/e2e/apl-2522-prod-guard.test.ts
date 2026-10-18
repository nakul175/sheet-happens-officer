// Starts the APL-2522 spec in a fresh Vitest process so the prod guard runs at import.
// Hostnames below are only arguments to that guard. Nothing in this file contacts them.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertStoryTargetAllowed } from "./base-url";

const PROD = "https://sheethappensofficer.com";
const PROD_APP = "https://app.sheethappensofficer.com";
const PROD_WWW = "https://www.sheethappensofficer.com";
const STAGING = "https://staging.sheethappensofficer.com";
const LOCAL = "http://127.0.0.1:9";

const safe = { BASE_URL: STAGING, TASKBOARD_URL: LOCAL, STAGING_URL: STAGING };

function runSpec(overrides: { BASE_URL: string; TASKBOARD_URL: string; STAGING_URL: string }) {
  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "node_modules/vitest/vitest.mjs"),
    "run",
    "tests/e2e/stories/APL-2522.spec.ts",
    "--config",
    "vitest.config.mts",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    env: { ...process.env, ...overrides },
  });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

describe("APL-2522 spec prod guard", () => {
  it("refuses a production TASKBOARD_URL when the spec starts", { timeout: 60_000 }, () => {
    const run = runSpec({ ...safe, TASKBOARD_URL: PROD_APP });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/Refusing to run story tests against production \(app\.sheethappensofficer\.com\)/);
  });

  it("refuses a production STAGING_URL when the spec starts", { timeout: 60_000 }, () => {
    const run = runSpec({ ...safe, STAGING_URL: PROD_WWW });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/Refusing to run story tests against production \(www\.sheethappensofficer\.com\)/);
  });

  // Linux keeps the starting BASE_URL in the process image after Vitest sets the live value to "/".
  it.skipIf(process.platform !== "linux")("refuses a production BASE_URL read before Vitest rewrites it to /", { timeout: 60_000 }, () => {
    const run = runSpec({ ...safe, BASE_URL: PROD });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
    expect(run.output).not.toMatch(/Refusing to run story tests against production \(staging\.sheethappensofficer\.com\)/);
  });

  it("lets the spec start when BASE_URL, TASKBOARD_URL and STAGING_URL are not production", { timeout: 60_000 }, () => {
    const run = runSpec(safe);
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("Refusing to run story tests against production");
  });

  it("does not consult the BASE_URL property on the environment object", () => {
    const env: NodeJS.ProcessEnv = { BASE_URL: PROD, TASKBOARD_URL: LOCAL, STAGING_URL: STAGING };
    expect(() => assertStoryTargetAllowed(env, STAGING)).not.toThrow();
    expect(() => assertStoryTargetAllowed({ ...env, BASE_URL: "/" }, PROD)).toThrow(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
  });

  it("treats a different host casing and a trailing dot as production, and keeps the userinfo out of the message", () => {
    let message = "";
    try {
      assertStoryTargetAllowed({ TASKBOARD_URL: "https://user:s3cret@SHEETHAPPENSOFFICER.com./tasks" }, STAGING);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
    expect(message).not.toContain("s3cret");
  });

  it("refuses a value that is not a URL without repeating that value", () => {
    expect(() => assertStoryTargetAllowed({ STAGING_URL: "not a url" }, STAGING)).toThrow(/^STAGING_URL is not a URL\.$/);
  });
});
