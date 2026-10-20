// Starts the APL-2522 spec in a fresh Vitest process so the prod guard runs at import.
// Hostnames below are only arguments to that guard. Nothing in this file contacts them.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertStoryTargetAllowed, startingBaseUrl } from "./base-url";

const PROD = "https://sheethappensofficer.com";
const PROD_APP = "https://app.sheethappensofficer.com";
const PROD_WWW = "https://www.sheethappensofficer.com";
// APL-2929: production moved to sheethappensofficer.aplyd.org. The guard refuses the old hosts and the new one.
const PROD_NEW = "https://sheethappensofficer.aplyd.org";
const STAGING = "https://staging.sheethappensofficer.com";
const LOCAL = "http://127.0.0.1:9";

const safe = { BASE_URL: STAGING, TASKBOARD_URL: LOCAL, STAGING_URL: STAGING };

function runSpec(overrides: { BASE_URL: string; TASKBOARD_URL: string; STAGING_URL: string }) {
  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "node_modules/vitest/vitest.mjs"),
    "run",
    "tests/e2e/local/APL-2522.test.ts",
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

  it("does not consult the BASE_URL property on the environment object", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", BASE_URL: PROD, TASKBOARD_URL: LOCAL, STAGING_URL: STAGING };
    expect(() => assertStoryTargetAllowed(env, STAGING)).not.toThrow();
    expect(() => assertStoryTargetAllowed({ ...env, BASE_URL: "/" }, PROD)).toThrow(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
  });

  it("treats a different host casing and a trailing dot as production, and keeps the userinfo out of the message", () => {
    let message = "";
    try {
      assertStoryTargetAllowed({ NODE_ENV: "test", TASKBOARD_URL: "https://user:s3cret@SHEETHAPPENSOFFICER.com./tasks" }, STAGING);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
    expect(message).not.toContain("s3cret");
  });

  it("allows a non-production target, including a bare hostname that is not production", () => {
    expect(() => assertStoryTargetAllowed({ NODE_ENV: "test", TASKBOARD_URL: LOCAL, STAGING_URL: STAGING }, STAGING)).not.toThrow();
    expect(() => assertStoryTargetAllowed({ NODE_ENV: "test", TASKBOARD_URL: "not a url" }, STAGING)).not.toThrow();
    expect(() => assertStoryTargetAllowed({ NODE_ENV: "test", TASKBOARD_URL: "sheethappensofficer.com" }, STAGING)).toThrow(/Refusing to run story tests against production \(sheethappensofficer\.com\)/);
  });

  it("refuses the production IP on any port, with or without a scheme", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    for (const value of ["http://168.144.144.69:3000", "168.144.144.69:3000", "https://168.144.144.69:443"]) {
      let message = "";
      try {
        assertStoryTargetAllowed({ ...env, TASKBOARD_URL: value }, STAGING);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message, value).toBe("Refusing to run story tests against production (168.144.144.69).");
      expect(message).not.toContain(":3000");
      expect(message).not.toContain(":443");
    }
  });

  it("qa:TC missing APL-2929 AC2: refuses the new production host sheethappensofficer.aplyd.org, as well as the old ones", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    for (const value of [PROD_NEW, `${PROD_NEW}/tasks`, "sheethappensofficer.aplyd.org:443", "https://SHEETHAPPENSOFFICER.aplyd.org."]) {
      expect(() => assertStoryTargetAllowed({ ...env, TASKBOARD_URL: value }, LOCAL), value).toThrow(
        "Refusing to run story tests against production (sheethappensofficer.aplyd.org).",
      );
    }
    expect(() => assertStoryTargetAllowed(env, PROD_NEW)).toThrow("Refusing to run story tests against production (sheethappensofficer.aplyd.org).");
    for (const [old, host] of [[PROD, "sheethappensofficer.com"], [PROD_APP, "app.sheethappensofficer.com"], [PROD_WWW, "www.sheethappensofficer.com"]]) {
      expect(() => assertStoryTargetAllowed({ ...env, STAGING_URL: old }, LOCAL), old).toThrow(`Refusing to run story tests against production (${host}).`);
    }
  });

  it("refuses a production host written with a port or a path and no scheme", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    for (const value of ["app.sheethappensofficer.com:443", "app.sheethappensofficer.com/tasks"]) {
      expect(() => assertStoryTargetAllowed({ ...env, STAGING_URL: value }, LOCAL), value).toThrow(
        "Refusing to run story tests against production (app.sheethappensofficer.com).",
      );
    }
  });

  it("fails closed when the starting BASE_URL cannot be read, and the error quotes no value", () => {
    const hidden = "https://user:s3cret@sheethappensofficer.com";
    const unread = { environ: null, underVitest: true, liveBaseUrl: hidden } as const;
    for (const platform of ["darwin", "linux"] as const) {
      let message = "";
      try {
        startingBaseUrl({ ...unread, platform });
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message, platform).toBe("Refusing to run: the starting BASE_URL could not be read.");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("sheethappensofficer");
    }
    const image = Buffer.from("OTHER=1\0BASE_URL=https://staging.sheethappensofficer.com\0", "latin1");
    expect(startingBaseUrl({ platform: "linux", environ: image, underVitest: true, liveBaseUrl: "/" })).toBe("https://staging.sheethappensofficer.com");
    expect(startingBaseUrl({ platform: "linux", environ: Buffer.from("OTHER=1\0", "latin1"), underVitest: true, liveBaseUrl: hidden })).toBeUndefined();
  });
});
