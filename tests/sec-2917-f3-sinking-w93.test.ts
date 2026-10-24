// SHO-2917 F3 residual (w93). The disposition (SEC-2917-F3-DISPOSITION.md) rules F3 DEFERRED, not closed: the guard
// inspected the environment expression at the point of check, so a value that reached the sink through a local binding,
// or through a helper in another file, was not followed. These are that residual's acceptance tests, written as data
// first: every string below is source the guard is asked to judge, never a call made here, so the AC1 tree scan still
// parses this file as plain source.
//
// The non-regression set is the five legal pass-throughs the disposition names, in their real spellings (located in the
// tree, not taken from the ticket): assertStoryTargetAllowed(process.env, BASE) and resolveBaseUrl(process.env) in
// tests/e2e/base-url.ts, runFreshNpmTest(env) in tests/readme-test-env.test.ts, configBaseUrl(env) in
// tests/e2e/base-url-target.test.ts, startChild(env) in tests/shutdown.test.ts. A fix that reports any of them is wrong.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { violations } from "./base-url-no-environ-dump.test";

/** The forms the one authoritative guard reports for source handed to it as a batch of files. */
const forms = (files: { file: string; text: string }[]): string[] => violations(files).map(({ form }) => form);
/** One snippet, judged alone. */
const oneFile = (text: string): string[] => forms([{ file: "tests/w93-shape.test.ts", text }]);
/** Snippets as a module graph: the caller imports the helper from a sibling file in the same batch. */
const moduleGraph = (entries: [string, string][]): string[] => forms(entries.map(([file, text]) => ({ file, text })));

// Axis (a), SINKING: the whole environment is bound to a local and only the local reaches the sink. Re-bound more than
// once, through a default, and through a helper declared in the same file.
const SINKING: [string, string][] = [
  ["a coalesce default", `const u = process.env ?? {};\nconsole.log(u);`],
  ["an or default", `const u = process.env || {};\nconsole.log(u);`],
  ["a local function taking the alias", `const e = process.env;\nfunction dump(x) { console.log(x); }\ndump(e);`],
  ["a local function taking process.env", `function dump(x) { console.log(x); }\ndump(process.env);`],
  ["an arrow bound as a const", `const e = process.env;\nconst dump = (x) => console.log(x);\ndump(e);`],
  ["a callee that lists its parameter", `function names(x) { return Object.keys(x); }\nnames(process.env);`],
  ["a callee that spreads its parameter", `function copy(x) { return { ...x }; }\ncopy(process.env);`],
  ["a callee that destructures a rest element", `function rest({ ...all }) { console.log(all); }\nrest(process.env);`],
  ["a chain re-bound in reverse order", `const d = c;\nconst c = b;\nconst b = a;\nconst a = process.env;\nconsole.log(d);`],
];

// Axis (b), CROSS-FILE: the value is handed to a helper defined in another module — one hop, then two.
const CROSS_FILE: [string, [string, string][]][] = [
  ["one hop, named import", [
    ["tests/w93-dump.ts", `export function dump(x) { console.log(x); }`],
    ["tests/w93-caller.ts", `import { dump } from "./w93-dump";\ndump(process.env);`],
  ]],
  ["two hops, each file importing the next", [
    ["tests/w93-inner.ts", `export function dump(x) { console.log(x); }`],
    ["tests/w93-relay.ts", `import { dump } from "./w93-inner";\nexport function relay(x) { dump(x); }`],
    ["tests/w93-caller2.ts", `import { relay } from "./w93-relay";\nrelay(process.env);`],
  ]],
  ["one hop, the helper lists it", [
    ["tests/w93-names.ts", `export function names(x) { return Object.entries(x); }`],
    ["tests/w93-caller3.ts", `import { names } from "./w93-names";\nnames(process.env);`],
  ]],
  ["one hop, default export", [
    ["tests/w93-default.ts", `export default function dump(x) { console.log(x); }`],
    ["tests/w93-caller4.ts", `import dump from "./w93-default";\ndump(process.env);`],
  ]],
  ["one hop, namespace import", [
    ["tests/w93-ns.ts", `export function dump(x) { console.log(x); }`],
    ["tests/w93-caller5.ts", `import * as h from "./w93-ns";\nh.dump(process.env);`],
  ]],
];

describe("SHO-2917 F3: a whole environment sunk through a local binding is reported", () => {
  for (const [shape, text] of SINKING) {
    it(`qa:TC missing AC1: the guard reports ${shape}`, () => {
      expect(oneFile(text), text).not.toEqual([]);
    });
  }
});

describe("SHO-2917 F3: a whole environment handed to a helper in another file is followed to its body", () => {
  for (const [shape, entries] of CROSS_FILE) {
    it(`qa:TC missing AC1: the guard reports ${shape}`, () => {
      expect(moduleGraph(entries), entries.map(([file]) => file).join(", ")).not.toEqual([]);
    });
  }
});

// The non-regression set. Each snippet below has the SHAPE of one of the five real helpers (its body, mirrored), so the
// new rule really resolves a callee and has to stay quiet — a helper that reads named keys, or hands a copy to a child
// process as its `env`, is a legal pass-through, not a leak.
const LEGAL_SAME_FILE: [string, string][] = [
  ["assertStoryTargetAllowed / resolveBaseUrl shape", `function allowed(env, base) { if (env.TASKBOARD_URL === base) return; return base; }\nallowed(process.env, "http://localhost:3100");`],
  ["runFreshNpmTest / startChild shape", `function start(env) { return spawn(bin, args, { cwd: root, env: { PATH: process.env.PATH, ...env }, stdio: "ignore" }); }\nstart(process.env);`],
  ["configBaseUrl shape", `function read(env) { return execFileSync(cmd, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8" }); }\nread(process.env);`],
];

const LEGAL_CROSS_FILE: [string, [string, string][]][] = [
  ["a named-key reader in another file", [
    ["tests/w93-reader.ts", `export function reader(env) { return (env.BASE_URL || env.TASKBOARD_URL || "http://localhost:3100").replace(/\\/+$/, ""); }`],
    ["tests/w93-legal1.ts", `import { reader } from "./w93-reader";\nreader(process.env);`],
  ]],
  ["a child-env helper in another file", [
    ["tests/w93-child.ts", `export function start(env) { return spawn(bin, args, { env: { ...process.env, ...env } }); }`],
    ["tests/w93-legal2.ts", `import { start } from "./w93-child";\nstart(process.env);`],
  ]],
  ["two hops of named-key reading", [
    ["tests/w93-inner-legal.ts", `export function base(env) { return env.STAGING_URL; }`],
    ["tests/w93-relay-legal.ts", `import { base } from "./w93-inner-legal";\nexport function target(env) { return base(env); }`],
    ["tests/w93-legal3.ts", `import { target } from "./w93-relay-legal";\ntarget(process.env);`],
  ]],
  ["a destructuring of named keys", [
    ["tests/w93-pick.ts", `export function pick({ BASE_URL }) { return BASE_URL; }`],
    ["tests/w93-legal4.ts", `import { pick } from "./w93-pick";\npick(process.env);`],
  ]],
];

describe("SHO-2917 F3: the legal pass-throughs the disposition names stay allowed", () => {
  for (const [shape, text] of LEGAL_SAME_FILE) {
    it(`qa:TC missing AC1: ${shape} stays quiet`, () => {
      expect(oneFile(text), text).toEqual([]);
    });
  }
  for (const [shape, entries] of LEGAL_CROSS_FILE) {
    it(`qa:TC missing AC1: ${shape} stays quiet`, () => {
      expect(moduleGraph(entries), entries.map(([file]) => file).join(", ")).toEqual([]);
    });
  }
});

// The real call sites, read off disk: this is the evidence that the five named helpers still pass, not a snippet that
// resembles them. tests/e2e/base-url.ts defines assertStoryTargetAllowed and resolveBaseUrl; the specs import and call
// them with the whole environment. The child-process helpers are pinned by their own files, which the AC1 tree scan also
// covers at the end of this run.
const realFiles = (...names: string[]): { file: string; text: string }[] =>
  names.map((file) => ({ file, text: readFileSync(file, "utf8") }));

describe("SHO-2917 F3: the five helpers' real call sites stay allowed", () => {
  it("qa:TC missing AC1: assertStoryTargetAllowed(process.env, BASE) and its definition stay quiet", () => {
    expect(forms(realFiles("tests/e2e/base-url.ts", "tests/e2e/local/APL-2714.test.ts",
      "tests/e2e/local/APL-2655.test.ts", "tests/e2e/stories/APL-2694.spec.ts"))).toEqual([]);
  });

  it("qa:TC missing AC1: resolveBaseUrl(env) through tests/e2e/helpers/local-clock.ts stays quiet", () => {
    expect(forms(realFiles("tests/e2e/base-url.ts", "tests/e2e/helpers/local-clock.ts",
      "tests/e2e/base-url-target.test.ts"))).toEqual([]);
  });

  it("qa:TC missing AC1: runFreshNpmTest(env), configBaseUrl(env) and startChild(env) stay quiet", () => {
    expect(forms(realFiles("tests/readme-test-env.test.ts", "tests/e2e/base-url-target.test.ts",
      "tests/shutdown.test.ts"))).toEqual([]);
  });
});


