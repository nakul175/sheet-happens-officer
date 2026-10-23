// APL-2917 AC1 at run time: tests/e2e/base-url.ts reads only its named variables from process.env and never lists the
// whole environment. process.env is wrapped in a Proxy that records variable names only (never values) while the module
// loads and its functions run, and node:fs file reads are recorded by path. No TC id is assigned on the issue.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("DEFECT OPEN — the guard lets the live production host sheethappensofficer.aplyd.com through", () => {
    // Report-only: this is the D1 finding in execution/BUG-2917.md, not a change to the guard (the fix needs its own
    // ticket). deploy.yml sets APP_HOST to aplyd.org, so aplyd.com is recorded as the production host the issue named.
    // Flip these to .toThrow once the production set contains it.
    expect(() => assertStoryTargetAllowed(envOf({ TASKBOARD_URL: "https://sheethappensofficer.aplyd.com" }))).not.toThrow();
  });
});
