// SHO-2917 residual (w105): the NEXT hole of the F3 class, not the fixed one. W93 taught the guard to follow a whole
// environment into a callee — a declaration or a const arrow in the same file, or a named/default/namespace import of
// another file. `functionsOf` records what a file DECLARES and `calleeOf` resolves exactly one import hop into that
// record. A file that hands a function on without declaring it — a barrel, `export { dump } from "./impl"` or
// `export * from "./impl"` — declares nothing, so the import resolves to a module that has no such function and the
// guard stays quiet: the environment can reach the sink through one extra file and nothing is reported. That is the
// "re-export" shape named in the SHO-2917 residual brief, in the same class as F3.
//
// Every string below is SOURCE the guard is asked to judge, never a call made here, so the AC1 tree scan still parses
// this file as plain source (the forms are quoted exactly as AC1 quotes them).
import { describe, expect, it } from "vitest";
import { violations } from "./base-url-no-environ-dump.test";

/** The forms the one authoritative guard reports for a batch of files. */
const forms = (entries: [string, string][]): string[] =>
  violations(entries.map(([file, text]) => ({ file, text }))).map(({ form }) => form);

const PASSED_WHOLE = "whole environment passed to a callee that reads it whole";

// The re-export shapes: the sink is one file further away than the import says. Each must be reported at the call site.
const RE_EXPORTS: [string, [string, string][]][] = [
  ["a named re-export through a barrel", [
    ["tests/w105-impl.ts", `export function dump(x) { console.log(x); }`],
    ["tests/w105-barrel.ts", `export { dump } from "./w105-impl";`],
    ["tests/w105-caller.ts", `import { dump } from "./w105-barrel";\ndump(process.env);`],
  ]],
  ["a renamed re-export through a barrel", [
    ["tests/w105-impl2.ts", `export function dump(x) { console.log(x); }`],
    ["tests/w105-barrel2.ts", `export { dump as shout } from "./w105-impl2";`],
    ["tests/w105-caller2.ts", `import { shout } from "./w105-barrel2";\nshout(process.env);`],
  ]],
  ["export * from a barrel", [
    ["tests/w105-impl3.ts", `export function names(x) { return Object.keys(x); }`],
    ["tests/w105-barrel3.ts", `export * from "./w105-impl3";`],
    ["tests/w105-caller3.ts", `import { names } from "./w105-barrel3";\nnames(process.env);`],
  ]],
  ["a default re-export through a barrel", [
    ["tests/w105-impl4.ts", `export default function dump(x) { console.log(x); }`],
    ["tests/w105-barrel4.ts", `export { default } from "./w105-impl4";`],
    ["tests/w105-caller4.ts", `import dump from "./w105-barrel4";\ndump(process.env);`],
  ]],
  ["a namespace import of a barrel", [
    ["tests/w105-impl5.ts", `export function entries(x) { return Object.entries(x); }`],
    ["tests/w105-barrel5.ts", `export { entries } from "./w105-impl5";`],
    ["tests/w105-caller5.ts", `import * as h from "./w105-barrel5";\nh.entries(process.env);`],
  ]],
  ["two barrels in a row", [
    ["tests/w105-impl6.ts", `export function spreadIt(x) { return { ...x }; }`],
    ["tests/w105-barrel6a.ts", `export { spreadIt } from "./w105-impl6";`],
    ["tests/w105-barrel6b.ts", `export { spreadIt } from "./w105-barrel6a";`],
    ["tests/w105-caller6.ts", `import { spreadIt } from "./w105-barrel6b";\nspreadIt(process.env);`],
  ]],
];

describe("SHO-2917 residual: a whole environment handed to a re-exported helper is reported", () => {
  for (const [shape, entries] of RE_EXPORTS) {
    it(`qa:TC missing AC1: ${shape} is reported at the call site`, () => {
      expect(forms(entries), entries.map(([file]) => file).join(", ")).toContain(PASSED_WHOLE);
    });
  }
});

// The non-regression set: following a re-export must not turn the five legal pass-throughs into findings. A barrel that
// hands on a named-key reader, or a helper that gives the copy to a child process, stays quiet.
const LEGAL_RE_EXPORTS: [string, [string, string][]][] = [
  ["a re-exported named-key reader", [
    ["tests/w105-reader.ts", `export function reader(env) { return (env.BASE_URL || env.TASKBOARD_URL || "http://localhost:3100").replace(/\\/+$/, ""); }`],
    ["tests/w105-reader-barrel.ts", `export { reader } from "./w105-reader";`],
    ["tests/w105-reader-caller.ts", `import { reader } from "./w105-reader-barrel";\nreader(process.env);`],
  ]],
  ["a re-exported child-env helper", [
    ["tests/w105-child.ts", `export function start(env) { return spawn(bin, args, { env: { ...process.env, ...env } }); }`],
    ["tests/w105-child-barrel.ts", `export * from "./w105-child";`],
    ["tests/w105-child-caller.ts", `import { start } from "./w105-child-barrel";\nstart(process.env);`],
  ]],
  ["a re-exported destructuring of named keys", [
    ["tests/w105-pick.ts", `export function pick({ BASE_URL }) { return BASE_URL; }`],
    ["tests/w105-pick-barrel.ts", `export { pick } from "./w105-pick";`],
    ["tests/w105-pick-caller.ts", `import { pick } from "./w105-pick-barrel";\npick(process.env);`],
  ]],
];

describe("SHO-2917 residual: the legal pass-throughs stay allowed through a re-export too", () => {
  for (const [shape, entries] of LEGAL_RE_EXPORTS) {
    it(`qa:TC missing AC1: ${shape} stays quiet`, () => {
      expect(forms(entries), entries.map(([file]) => file).join(", ")).toEqual([]);
    });
  }
});
