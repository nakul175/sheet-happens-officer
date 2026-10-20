// APL-2917 AC1 at run time: tests/e2e/base-url.ts reads only its named variables from process.env and never lists the
// whole environment. process.env is wrapped in a Proxy that records variable names only (never values) while the module
// loads and its functions run, and node:fs file reads are recorded by path. No TC id is assigned on the issue.
import { afterEach, describe, expect, it, vi } from "vitest";

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
