// APL-2917 AC1 at run time: tests/e2e/base-url.ts reads only its named variables from process.env and never lists the
// whole environment. process.env is wrapped in a Proxy that records variable names only (never values) while the module
// loads and its functions run, and node:fs file reads are recorded by path. No TC id is assigned on the issue.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DEFAULT, assertStoryTargetAllowed, resolveBaseUrl } from "./e2e/base-url";

const NAMED = ["VITEST", "SHO_E2E_START_BASE_URL", "BASE_URL", "TASKBOARD_URL", "STAGING_URL"];
const realEnv = process.env;

function recordEnvReads() {
  const names = new Set<string>();
  let listed = 0;
  process.env = new Proxy(realEnv, {
    get(target, key, receiver) {
      if (typeof key === "string") names.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") names.add(key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      listed++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === "string") names.add(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { names, listed: () => listed };
}

afterEach(() => {
  process.env = realEnv;
});

describe("qa:TC missing APL-2917 AC1: base-url.ts reads only its named variables", () => {
  it("qa:TC missing AC1: loading the module and resolving the target read only named variables and never list the environment", async () => {
    vi.resetModules();
    const read: string[] = [];
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      const record = (file: unknown) => read.push(String(file));
      const readFileSync = ((file: unknown, ...rest: unknown[]) => (record(file), (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest))) as typeof fs.readFileSync;
      const readFile = ((file: unknown, ...rest: unknown[]) => (record(file), (fs.readFile as (...a: unknown[]) => unknown)(file, ...rest))) as typeof fs.readFile;
      const openSync = ((file: unknown, ...rest: unknown[]) => (record(file), (fs.openSync as (...a: unknown[]) => unknown)(file, ...rest))) as typeof fs.openSync;
      return { ...fs, default: { ...fs, readFileSync, readFile, openSync }, readFileSync, readFile, openSync };
    });
    const rec = recordEnvReads();
    const mod = await import("./e2e/base-url");
    mod.baseUrlAtProcessStart();
    mod.resolveBaseUrl();
    mod.assertStoryTargetAllowed(process.env, "http://localhost:3100");
    process.env = realEnv;
    vi.doUnmock("node:fs");
    expect(read, "files read through node:fs while base-url.ts loaded and ran").toEqual([]);
    expect(rec.listed(), "the environment was listed (Object.keys, spread, for...in or similar)").toBe(0);
    expect([...rec.names].filter((name) => !NAMED.includes(name)), "variables read outside the named set").toEqual([]);
    expect([...rec.names].sort()).toEqual(expect.arrayContaining(["BASE_URL", "SHO_E2E_START_BASE_URL", "VITEST"]));
  });
});

// SHO-2917 AC2, kept beside AC1 in one file so the whole base-url guard runs in one command. Nothing here contacts a host.
const PRODUCTION = "https://sheethappensofficer.aplyd.org";
/** A stand-in environment: the guard reads only these named keys. */
const envOf = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;
const STAGING = "https://staging.sheethappensofficer.com";
const LOCAL = "http://localhost:3100";

describe("qa:TC missing SHO-2917 AC2: the guard refuses production and allows staging", () => {
  it("qa:TC missing AC2: assertStoryTargetAllowed throws for the production host in each target variable", () => {
    // The live BASE_URL default is "/" under Vitest, so the starting value is passed explicitly where it is the subject.
    for (const slot of ["TASKBOARD_URL", "STAGING_URL"] as const) {
      expect(() => assertStoryTargetAllowed(envOf({ [slot]: PRODUCTION })), slot).toThrow(
        "Refusing to run story tests against production (sheethappensofficer.aplyd.org).",
      );
    }
    expect(() => assertStoryTargetAllowed(envOf({}), PRODUCTION)).toThrow(
      "Refusing to run story tests against production (sheethappensofficer.aplyd.org).",
    );
  });

  it("qa:TC missing AC2: assertStoryTargetAllowed allows the staging and local hosts", () => {
    expect(() => assertStoryTargetAllowed(envOf({ TASKBOARD_URL: LOCAL, STAGING_URL: STAGING }), STAGING)).not.toThrow();
    expect(() => assertStoryTargetAllowed(envOf({ TASKBOARD_URL: LOCAL, STAGING_URL: STAGING }), LOCAL)).not.toThrow();
    expect(() => assertStoryTargetAllowed(envOf({}), LOCAL)).not.toThrow();
  });

  it("qa:TC missing AC2: resolveBaseUrl resolves the staging and local targets, and does not itself refuse production", () => {
    // The guard, not the resolver, is what refuses production: resolveBaseUrl returns whatever the variables say, so
    // every story calls the guard first. The second assertion pins that contract, whatever the value is.
    expect(resolveBaseUrl({ BASE_URL: STAGING })).toBe(STAGING);
    expect(resolveBaseUrl({ TASKBOARD_URL: LOCAL })).toBe(LOCAL);
    expect(resolveBaseUrl({})).toBe(LOCAL_DEFAULT);
    expect(resolveBaseUrl({ BASE_URL: PRODUCTION })).toBe(PRODUCTION);
    expect(() => assertStoryTargetAllowed(envOf({}), resolveBaseUrl({ BASE_URL: PRODUCTION }))).toThrow(/Refusing to run story tests against production/);
  });

  // DEFECT OPEN (D1 in execution/BUG-2917.md, no ticket yet): the guard does not treat sheethappensofficer.aplyd.com as
  // production. Recorded as a todo rather than an assertion: a `.not.toThrow()` here would make fixing the production set
  // FAIL this suite. When the host is added to PRODUCTION_HOSTS, turn this into a `.toThrow` case.
  it.todo("DEFECT OPEN — decide whether sheethappensofficer.aplyd.com is production; the guard currently allows it");
});

// REVIEW-2917 R3: pin the import-time refusal in tests/e2e/base-url.ts:98-102. The previous claim said "pin the base-url
// production guard", but nothing started a real process with a production BASE_URL. Shape follows
// tests/e2e/apl-2522-prod-guard.test.ts:18-32: spawn a child that imports the module and prints a marker if it got past
// the guard. Hostnames are only arguments; no host is contacted.
const IMPORT_PROBE = (
  "import(\"<BASE_URL>\").then(() => { console.log(\"IMPORTED\"); process.exit(0); })"
);
function runImportProbe(baseUrl: string) {
  const probe = IMPORT_PROBE.replace("<BASE_URL>", `${process.cwd()}/tests/e2e/base-url.ts`);
  const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    // A child that inherits the harness env but not Vitest's VITEST marker: the guard only runs outside Vitest.
    env: { ...process.env, VITEST: "", BASE_URL: baseUrl, SHO_E2E_START_BASE_URL: "", TASKBOARD_URL: "", STAGING_URL: "" },
  });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

describe("REVIEW-2917 R3: the base-url guard refuses production at import time, in a real fresh process", () => {
  it("qa:TC missing AC2: importing tests/e2e/base-url.ts with a production BASE_URL aborts before anything runs", { timeout: 60_000 }, () => {
    const run = runImportProbe("https://sheethappensofficer.aplyd.org");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/Refusing to run story tests against production \(sheethappensofficer\.aplyd\.org\)/);
    expect(run.output, "the module loaded instead of refusing").not.toMatch(/IMPORTED/);
  });

  it("qa:TC missing AC2: importing tests/e2e/base-url.ts with the staging BASE_URL loads normally", { timeout: 60_000 }, () => {
    const run = runImportProbe(STAGING);
    expect(run.output).toMatch(/IMPORTED/);
    expect(run.output).not.toMatch(/Refusing to run/);
  });

  it.todo("DEFECT OPEN — decide whether sheethappensofficer.aplyd.com is production; the import-time guard currently allows it");
});
