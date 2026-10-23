// SHO-2917 AC1/AC3 as a static proof, and the ONE authoritative guard for it (`violations`). This file parses every
// test file with the TypeScript compiler (comments ignored) and refuses every way to read the environment as a whole:
//   1. The process image file (/proc/self/environ, /proc/<pid>/environ, /proc/self/cmdline) read through node:fs — by
//      literal, by `+`, by ${...}, by path.join, OR through a name bound to such a string in the same file.
//   2. A spread, dump, copy, listing or iteration of process.env itself, including Object.keys/entries/values,
//      Reflect.ownKeys, getOwnPropertyNames, JSON.stringify, util.inspect, process.stdout.write, Object.assign and
//      for...in.
//   3. Any of the above reached through ONE HOP of indirection resolved within the same file: `const e = process.env`,
//      `const { ...all } = process.env`, `const { ...rest } = e`, `process["env"]`, `process[`env`]`,
//      `globalThis.process.env`, `globalThis["process"].env`, `const p = process; p.env`, and the same names again in a
//      listing (`Object.keys(e)`), a dump (`console.log(e)`) or a spread (`{ ...e }`). A name bound to such an alias
//      (`const also = e`) is followed too.
// The file names the banned forms in its own patterns and examples, so the scan leaves this file and the delegating
// tests/no-proc-environ-2917.test.ts out. It is a superset of that file's scan: `violations` calls its
// `environReaders` for the process-image cases this AST pass might miss, so one guard answers AC1/AC3.
// No TC id is assigned on the issue. Follow-ups SHO-3031 and SHO-3032 are not exercised here (see BUG-2917.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { environReaders } from "./no-proc-environ-2917.test";

export const SELF = path.join("tests", "base-url-no-environ-dump.test.ts");
export const OLD_GUARD = path.join("tests", "no-proc-environ-2917.test.ts");
const TESTS_DIR = "tests";
/** Call sites whose `env` option is a child process' environment rather than an object field that happens to be named env. */
const CALLS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(c|m)?[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * True when the expression names the environ or cmdline file under /proc: by literal, by `+`, by ${...}, by path.join, or
 * through a name bound to a path piece in the same file (`const P = "/proc/self/environ"; readFileSync(P)`).
 */
function namesProcessImage(node: ts.Node, bindings?: Bindings): boolean {
  const ENVIRON = /\/proc\/.*(\/environ|\/cmdline)\b/;
  const rebuild = (inner: ts.Node): string => {
    if (ts.isStringLiteralLike(inner)) return inner.text;
    // A name bound to a proc path piece or to the whole path: treat it as the path, whichever piece it was.
    if (bindings && ts.isIdentifier(inner) && bindings.proc.has(inner.text)) return "/proc/self/environ";
    if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => "${}" + span.literal.text).join("");
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return rebuild(inner.left) + rebuild(inner.right);
    // path.join("/proc", "self", "environ"): every argument is a piece of the path.
    if (ts.isCallExpression(inner)) return inner.arguments.map((argument) => (ts.isStringLiteralLike(argument) ? argument.text : "${}")).join("/");
    return "${}";
  };
  return ENVIRON.test(rebuild(node));
}

/** A proc-bound name used anywhere inside the expression: `P + "environ"`, `` `${dir}/self/environ` ``. */
function usesProcName(node: ts.Node, bindings?: Bindings): string | null {
  if (!bindings || bindings.proc.size === 0) return null;
  let found: string | null = null;
  const walk = (inner: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(inner) && bindings.proc.has(inner.text)) { found = inner.text; return; }
    ts.forEachChild(inner, walk);
  };
  walk(node);
  return found;
}

/**
 * The names a file binds to the whole environment, or to a string naming the process image, in one hop. Both are
 * same-file, flow-insensitive resolutions: a name bound anywhere in the file counts everywhere in it. That over-reports
 * at worst (a name reused for an unrelated value flags a read the file may not make), never under-reports — which is the
 * direction a security guard must err in.
 */
export type Bindings = { env: Set<string>; proc: Set<string>; process: Set<string> };
/** A path piece under /proc: "/proc", "/proc/self/", or a template head that names /proc. */
const PROC_PIECE = /^\/proc\/?(self\/?|\d+\/?)?$/;

/** `process.env` written directly, as `process.env`, `process["env"]`, `process[`env`]`, `globalThis.process.env`. */
function isEnvAccess(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return isEnvAccess(node.expression);
  const keyOf = (inner: ts.Node): string | null => {
    if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
    if (ts.isElementAccessExpression(inner) && inner.argumentExpression && ts.isStringLiteralLike(inner.argumentExpression)) return inner.argumentExpression.text;
    return null;
  };
  const ownerName = (inner: ts.Node): string | null => {
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) return ownerName(inner.expression);
    if (ts.isIdentifier(inner)) return inner.text;
    return null;
  };
  if (keyOf(node) !== "env") return false;
  const owner = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? ownerName(node.expression) : null;
  // `process.env`, `env:` on an object literal's own key is not this shape, and `x.env` on a custom object is not either.
  return owner === "process";
}

/** `process` itself, `globalThis.process`, `globalThis["process"]`, or a name bound to any of those (`const p = process`). */
function isProcessObject(node: ts.Node, bindings: Bindings, depth = 0): boolean {
  if (depth > 4) return false;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return isProcessObject(node.expression, bindings, depth + 1);
  if (ts.isIdentifier(node)) return node.text === "process" || bindings.process.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "process" && ts.isIdentifier(node.expression) && node.expression.text === "globalThis";
  if (ts.isElementAccessExpression(node)) {
    return Boolean(node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "process"
      && ts.isIdentifier(node.expression) && node.expression.text === "globalThis");
  }
  return false;
}

/** `p.env` where `p` is the process object: `(...).env`, `(...)["env"]`, with or without an optional chain. */
function isEnvOfProcess(node: ts.Node, bindings: Bindings): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return isEnvOfProcess(node.expression, bindings);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "env" && isProcessObject(node.expression, bindings);
  if (ts.isElementAccessExpression(node)) {
    return Boolean(node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "env"
      && isProcessObject(node.expression, bindings));
  }
  return false;
}

/** The identifiers a declaration binds: `x`, `{ a, b: c }`, `{ ...rest }`, `[x, y]`. */
function boundNames(name: ts.Node, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) boundNames(element.name, out);
    }
  }
  return out;
}

/** True when the expression is a piece of the proc path: "/proc", "/proc/self/", `/proc/${pid}/`. */
function namesProcPiece(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node)) return PROC_PIECE.test(node.text);
  if (ts.isTemplateExpression(node)) return PROC_PIECE.test(`${node.head.text}/`);
  return false;
}

/** Every name in the file bound to the environment, the process image path, or the process object. */
function collectBindings(source: ts.SourceFile): Bindings {
  const bindings: Bindings = { env: new Set(), proc: new Set(), process: new Set() };
  // One hop is enough for the alias shapes above; the second pass picks up `const also = e` after `e` is known.
  for (let pass = 0; pass < 3; pass++) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && !ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)) {
        if (ts.isIdentifier(node.name)) {
          const init = node.initializer;
          if (isWholeEnv(init, bindings) || isEnvOfProcess(init, bindings)) bindings.env.add(node.name.text);
          if (ts.isIdentifier(init) && bindings.env.has(init.text)) bindings.env.add(node.name.text);
          if (isProcessObject(init, bindings)) bindings.process.add(node.name.text);
          // A string that is a piece of the proc path (`"/proc/self/"`, `"/proc"`) or spans it: a proc name.
          if (namesProcessImage(init, bindings) || namesProcPiece(init) || (ts.isIdentifier(init) && bindings.proc.has(init.text))) bindings.proc.add(node.name.text);
        }
      }
      // `const { ...all } = process.env` and `const { ...rest } = e`: a rest element of the whole environment is a copy.
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        const parent = node.parent;
        const fromEnv = Boolean(parent && ts.isVariableDeclaration(parent) && parent.initializer
          && (isWholeEnv(parent.initializer, bindings) || isEnvOfProcess(parent.initializer, bindings)));
        if (fromEnv) {
          for (const name of boundNames(node)) bindings.env.add(name);
        }
      }
      // Assignment without a declaration: `let e; e = process.env;`
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)
        && (isWholeEnv(node.right, bindings) || isEnvOfProcess(node.right, bindings))) bindings.env.add(node.left.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bindings;
}


function isWholeEnv(node: ts.Node, bindings?: Bindings): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isWholeEnv(node.expression, bindings);
  // A name bound to the whole environment in this file: `const e = process.env; console.log(e)`.
  if (bindings && ts.isIdentifier(node)) return bindings.env.has(node.text);
  if (bindings && isEnvOfProcess(node, bindings)) return true;
  // String(process.env), util.inspect(process.env), JSON.stringify(process.env): the argument is the environment.
  if (ts.isCallExpression(node) && node.arguments.length === 1 && /^(String|JSON\.stringify|util\.inspect|util\.format)$/.test(node.expression.getText())) return isWholeEnv(node.arguments[0], bindings);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process";
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression.getText();
    const method = node.expression.name.text;
    // Object.keys(process.env), Object.entries(...), Object.values(...), Reflect.ownKeys(process.env)
    if (owner === "Object" && ["keys", "entries", "values"].includes(method) && node.arguments.length === 1) return isWholeEnv(node.arguments[0], bindings);
    if (owner === "Reflect" && method === "ownKeys" && node.arguments.length === 1) return isWholeEnv(node.arguments[0], bindings);
    // Object.getOwnPropertyNames(process.env)
    if (owner === "Object" && method === "getOwnPropertyNames" && node.arguments.length === 1) return isWholeEnv(node.arguments[0], bindings);
  }
  return false;
}

/** True when the call writes its argument out whole: console.*, JSON.stringify, util.inspect/format, process.stdout.write. */
function isDumpCall(node: ts.CallExpression): boolean {
  // console.log(...) / console.error(...) — the owner is the identifier `console`.
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "console") return true;
  // process.stdout.write(...) / process.stderr.write(...).
  if (/^(process\.(stdout|stderr))\.(write)$/.test(node.expression.getText())) return true;
  // JSON.stringify(...), util.inspect(...), util.format(...).
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = callee.expression.getText();
  return (owner === "JSON" && callee.name.text === "stringify") || (owner === "util" && ["inspect", "format"].includes(callee.name.text));
}

export type Violation = { file: string; line: number; form: string; text: string };

/** Every whole-environment read in the given files, parsed as source (so comments and dead strings stay quiet). */
export function wholeEnvReads(files: { file: string; text: string }[]): Violation[] {
  const found: Violation[] = [];
  for (const { file, text } of files) {
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX
      : /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    // A spread of the whole environment is a per-key copy only when it is handed to a child process as its `env`. Mark
    // exactly those: a spawn call's own `env:` object, and `env:` objects of any call whose object holds a marked copy.
    const bindings = collectBindings(source);
    const spawnEnvSpreads = new Set<ts.Node>();
    const envCopies = new Map<string, ts.Node>();
    const isSpawnCall = (node: ts.Node): node is ts.CallExpression => (ts.isCallExpression(node) || ts.isNewExpression(node)) && (
      (ts.isPropertyAccessExpression(node.expression) && CALLS.has(node.expression.name.text))
      || (ts.isIdentifier(node.expression) && CALLS.has(node.expression.text)));
    const spreadsIn = (node: ts.Node): ts.Node[] => {
      const out: ts.Node[] = [];
      const walk = (inner: ts.Node): void => {
        if (ts.isSpreadAssignment(inner) || ts.isSpreadElement(inner)) {
          if (isWholeEnv(inner.expression, bindings)) out.push(inner);
          if (ts.isIdentifier(inner.expression)) out.push(...(envCopies.get(inner.expression.text) ? [envCopies.get(inner.expression.text)!] : []));
        }
        ts.forEachChild(inner, walk);
      };
      walk(node);
      return out;
    };
    // 1. `const env: ProcessEnv = { ...process.env }` at any place: a copy, whose own spread is marked.
    const collectCopies = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const literal = ts.isAsExpression(node.initializer) && ts.isObjectLiteralExpression(node.initializer.expression)
          ? node.initializer.expression
          : ts.isObjectLiteralExpression(node.initializer) ? node.initializer : null;
        const typed = /ProcessEnv/.test((node.type ? node.type.getText() : "") + (ts.isAsExpression(node.initializer) ? node.initializer.type.getText() : ""));
        if (literal && typed) envCopies.set(node.name.text, literal);
      }
      ts.forEachChild(node, collectCopies);
    };
    collectCopies(source);
    for (const name of envCopies.keys()) for (const spread of spreadsIn(envCopies.get(name)!)) spawnEnvSpreads.add(spread);
    // 2. Any `env:` option inside a child-process call: `spawn(x, args, { env: {...process.env} })`,
    //    or `pool.start({ label, env: ({ port }) => ({ ...process.env, PORT }) })` reached from a spawn.
    const markCallEnv = (call: ts.CallExpression | ts.NewExpression): boolean => {
      let marked = false;
      for (const argument of call.arguments ?? []) {
        if (!ts.isObjectLiteralExpression(argument)) continue;
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) || property.name.getText() !== "env") continue;
          const marks = spreadsIn(property.initializer);
          if (marks.length) { marks.forEach((spread) => spawnEnvSpreads.add(spread)); marked = true; }
        }
      }
      return marked || isSpawnCall(call);
    };
    const markChildEnvs = (node: ts.Node, inChildCall: boolean): void => {
      const call = ts.isCallExpression(node) || ts.isNewExpression(node) ? node : null;
      if (call && inChildCall) markCallEnv(call);
      const child = inChildCall || Boolean(call && markCallEnv(call));
      ts.forEachChild(node, (inner) => markChildEnvs(inner, child));
    };
    markChildEnvs(source, false);

    const report = (node: ts.Node, form: string) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ file, line: line + 1, form, text: node.getText().slice(0, 120) });
    };
    const visit = (node: ts.Node): void => {
      // A clone kept in a plain variable is still the whole environment in one place: report it.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'structuredClone'
        && isWholeEnv(node.arguments[0], bindings)) report(node, 'whole environment copied');
      // 1. A spread of the whole environment: { ...process.env }, unless it is only the env of a child process.
      if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isWholeEnv(node.expression, bindings) && !spawnEnvSpreads.has(node)) {
        report(node, "spread of process.env");
      }
      if (ts.isCallExpression(node)) {
        // 3. A whole environment handed to a dump API: console.log(process.env), JSON.stringify(process.env)
        if (isDumpCall(node) && node.arguments.some((argument) => isWholeEnv(argument, bindings))) report(node, "whole environment dumped");
        if (ts.isPropertyAccessExpression(node.expression)) {
          const owner = node.expression.expression.getText();
          const method = node.expression.name.text;
          // 2. A whole environment copied elsewhere: Object.assign(target, process.env)
          if (owner === "Object" && method === "assign" && node.arguments.length > 1 && isWholeEnv(node.arguments[1], bindings)) {
            report(node, "whole environment copied");
          }
        }
      }
      // 4. A whole environment listed in place: Object.keys(process.env)
      if (ts.isCallExpression(node) && isWholeEnv(node, bindings)) report(node, "whole environment listed");
      // 4b. A REST element of a bound environment is a whole copy: `const e = process.env; const { ...rest } = e`. Naming
      // individual keys (`const { HOME } = e`) stays a named read, as it is for `const { HOME } = process.env`.
      if (ts.isObjectBindingPattern(node) && bindings && bindings.env.size > 0) {
        const parent = node.parent;
        const initializer = ts.isVariableDeclaration(parent) ? parent.initializer : undefined;
        const fromEnv = initializer !== undefined && isWholeEnv(initializer, bindings);
        if (fromEnv && node.elements.some((element) => ts.isBindingElement(element) && Boolean(element.dotDotDotToken))) report(node, "whole environment destructured");
      }
      if (ts.isForInStatement(node) && isWholeEnv(node.expression, bindings)) report(node, "whole environment iterated");
      // 5. The process image file read through node:fs, however the path is built.
      if (ts.isCallExpression(node) && node.arguments.some((argument) => namesProcessImage(argument, bindings)
        // A proc-bound name only counts when the same expression also names the file: `P + "environ"`, `${dir}/environ`.
        || (usesProcName(argument, bindings) !== null && /environ|cmdline/.test(argument.getText())))) report(node, "process image file read");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * The files under tests/ as { file, text }, leaving out this one file and the delegating APL-2917 guard: both name the
 * banned forms in their own self-test data on purpose. `dir` lets the shell harnesses in this file run the same scan
 * against a throwaway copy of the tree, so the proof is a real file on disk, not only a string.
 */
export function scannedFiles(dir: string = TESTS_DIR): { file: string; text: string }[] {
  return filesUnder(dir)
    .map((full) => ({ file: path.join(dir, path.relative(dir, full)), text: readFileSync(full, "utf8") }))
    .filter(({ file }) => file !== SELF && file !== OLD_GUARD);
}

/**
 * The one authoritative AC1/AC3 verdict: the process-image reads the older APL-2917 guard knows (path built with `+`,
 * `${...}` or path.join, in any file) UNION the whole-environment forms this file adds (spread, dump, listing,
 * iteration, /proc read, and one-file alias/element-access resolution of `process.env`).
 */
export function violations(files: { file: string; text: string }[]): Violation[] {
  // The two guard files name the banned forms on purpose; the exclusion lives here so no caller can forget it. Compared by
  // base name, because a scan of a throwaway copy of tests/ reports absolute paths.
  const scanners = new Set([path.basename(SELF), path.basename(OLD_GUARD)]);
  const scanned = files.filter(({ file }) => !scanners.has(path.basename(file)));
  const image: Violation[] = environReaders(scanned).map((file) => ({ file, line: 0, form: "process image file read", text: "" }));
  return [...image, ...wholeEnvReads(scanned)];
}

describe("qa:TC missing SHO-2917 AC1: no file under tests/ reads the environment as a whole", () => {
  it("qa:TC missing AC1: every test file parses as source and reads only named variables", () => {
    const files = scannedFiles();
    expect(files.length, "test files scanned").toBeGreaterThan(50);
    expect(violations(files)).toEqual([]);
  });

  it("qa:TC missing AC1: tests/e2e/base-url.ts is among the files scanned", () => {
    expect(scannedFiles().map(({ file }) => file)).toContain(path.join("tests", "e2e", "base-url.ts"));
  });

  it("qa:TC missing AC1: the check catches each way of reading the whole environment", () => {
    for (const [form, text] of [
      ["readFileSync environ", `readFileSync("/proc/self/environ", "utf8")`],
      ["template path with process.pid", "readFileSync(`/proc/${process.pid}/environ`, \"utf8\")"],
      ["path.join", `readFileSync(path.join("/proc", "self", "environ"), "utf8")`],
      ["concatenated path", `readFileSync("/proc/self/" + "environ")`],
      ["cmdline", `readFileSync("/proc/self/cmdline", "utf8")`],
      ["readFile", `import { readFile } from "node:fs/promises"; await readFile("/proc/self/environ")`],
      // A path assembled at run time from the real pieces.
      ["path.join of the real pieces", `readFileSync(path.join("/proc/self", "/environ"), "utf8")`],
      // A routine object spread of the live environment, the way the removed tc helper did it.
      ["spread", `const request = { ...process.env, accept: "json" };`],
      // A child process that does NOT inherit env (no env option on a plain call), or one asking for a copy another way.
      ["spread outside spawn env", `spawn(bin, { ...process.env, PORT: "3191" });`],
      ["spawn env copied", `spawn(bin, args, { env: Object.assign({}, process.env) });`],
      ["structuredClone", `const copy = structuredClone(process.env);`],
      ["console", `console.log(process.env);`],
      ["JSON.stringify", `throw new Error(JSON.stringify(process.env));`],
      ["Object.keys", `const names = Object.keys(process.env);`],
      ["Object.entries", `for (const [k, v] of Object.entries(process.env)) void [k, v];`],
      ["for...in", `for (const key in process.env) void key;`],
      ["process.stdout.write", `process.stdout.write(String(process.env));`],
      // A spread handed on as a spawn env is fine; the same shape spread into anything else is not.
      ["spread into a request", `const r = { env: { ...process.env } }; send(r);`],
      ["spread of a copy into a request", `const env = { ...process.env }; const r = { headers: { ...env } }; send(r);`],
    ] as const) {
      expect(wholeEnvReads([{ file: "x.test.ts", text }]).map(({ form: hit }) => hit), `${form}: ${text}`).not.toEqual([]);
    }
  });

  it("qa:TC missing AC1: the check leaves named reads, comments, and per-key copies for a child alone", () => {
    for (const text of [
      "const url = process.env.TASKBOARD_URL;",
      'const flag = process.env["FEATURE_COMMENTS"];',
      'process.env[FLAG] = "true";',
      "delete process.env.FEATURE_COMMENTS;",
      "const { BASE_URL, TASKBOARD_URL } = process.env;",
      // A named key destructured through one hop of indirection is still a named read, not a whole-environment read:
      // it reads HOME and nothing else. The alias resolution below is for reads that take the WHOLE object (a spread,
      // a rest element, a listing, a dump). Flagging this form would fail the guard on `const { BASE_URL } = e`, which
      // is the same access as the line above — so it is allowed, and `const e = process.env; const { ...rest } = e`
      // (the form that really does copy everything) is reported instead.
      "const e = process.env; const { HOME } = e; void HOME;",
      // A deliberate per-key copy passed to a child process is not a dump. Directly, and through a named copy the way
      // the mode-server tests do it (`const env: ProcessEnv = { ...process.env }` then `{ env }`).
      'const child = spawn(bin, args, { env: { ...process.env, PORT: "3191" } });',
      'const done = spawnSync(process.execPath, script, { encoding: "utf8", env: { ...process.env, SHO_X: "1" } });',
      'const env: NodeJS.ProcessEnv = { ...process.env }; spawn("npx", args, { cwd: root, env, detached: true });',
      'const env: NodeJS.ProcessEnv = { ...process.env };\nconst started = await pool.start({ label: "x", env: ({ port }) => ({ ...process.env, PORT: String(port) }) });',
      'const env: NodeJS.ProcessEnv = { ...process.env }; spawn(bin, args, { env, detached: true });',
      'const env = { ...process.env } as NodeJS.ProcessEnv; spawn(bin, args, { env, detached: true });',
      "assertStoryTargetAllowed(process.env, BASE);",
      "resolveBaseUrl(process.env);",
      'readFileSync("/proc/self/stat", "utf8");',
      'readFileSync(path.join(root, "environments", "x.json"), "utf8");',
      "// process.env is never read as a whole: no spread, no Object.keys(process.env).",
      '/* readFileSync("/proc/self/environ") was removed in APL-2917. */',
      'const message = "the environment is not read";',
    ]) {
      expect(wholeEnvReads([{ file: "y.test.ts", text }]), text).toEqual([]);
    }
  });
});

// REVIEW-2917 R2: the reviewer dropped a real file containing `const liveEnv = process.env; console.log(JSON.stringify(liveEnv))`
// into tests/ and the scanner stayed green. These cases pin the alias / element-access resolution that closes it, and the
// narrowing is stated in the header above: resolution is same-file and flow-insensitive, so a name that is ever bound to
// the environment counts everywhere in its file.
const ENV_DUMPS = [
  ["alias then dump", "const e = process.env; console.log(e);"],
  ["alias then stringify", "const e = process.env; JSON.stringify(e);"],
  ["alias then Object.keys", "const e = process.env; Object.keys(e);"],
  ["alias then Object.entries", "const e = process.env; Object.entries(e);"],
  ["alias then Reflect.ownKeys", "const e = process.env; Reflect.ownKeys(e);"],
  ["alias then getOwnPropertyNames", "const e = process.env; Object.getOwnPropertyNames(e);"],
  ["alias then spread", "const e = process.env; const copy = { ...e };"],
  ["alias then for...in", "const e = process.env; for (const k in e) void k;"],
  ["alias then stdout", "const e = process.env; process.stdout.write(String(e));"],
  ["alias of an alias", "const e = process.env; const also = e; console.log(also);"],
  ["element access", 'console.log(process["env"]);'],
  ["template element access", "console.log(process[`env`]);"],
  ["element access listing", 'Object.keys(process["env"]);'],
  ["globalThis.process.env", "console.log(globalThis.process.env);"],
  ["globalThis element access", 'console.log(globalThis["process"].env);'],
  ["process alias", "const p = process; console.log(p.env);"],
  ["rest destructure", "const { ...all } = process.env; console.log(all);"],
  ["rest destructure of alias", "const e = process.env; const { ...rest } = e; console.log(rest);"],
  ["assignment after declaration", "let e; e = process.env; console.log(e);"],
  ["alias passed to a listing helper", 'const e = process.env; Object.assign({}, e);'],
] as const;

describe("REVIEW-2917 R2: one hop of indirection does not hide a whole-environment read", () => {
  it("qa:TC missing AC1: every alias, element access and globalThis form is reported", () => {
    for (const [form, text] of ENV_DUMPS) {
      expect(wholeEnvReads([{ file: "zz-direct.test.ts", text }]), `${form}: ${text}`).not.toEqual([]);
    }
  });

  it("qa:TC missing AC1: the reviewer's exact dropped file is reported", () => {
    const reviewer = 'import { describe, it, expect } from "vitest";\nconst liveEnv = process.env;\nconsole.log(JSON.stringify(liveEnv));\ndescribe("p", () => { it("x", () => { expect(1).toBe(1); }); });\n';
    expect(wholeEnvReads([{ file: path.join("tests", "zz-direct.test.ts"), text: reviewer }])).toContainEqual(
      expect.objectContaining({ file: path.join("tests", "zz-direct.test.ts"), form: "whole environment dumped" }),
    );
  });

  it("qa:TC missing AC1: a name bound to a path piece does not hide a process-image read either", () => {
    for (const text of [
      'const P = "/proc/self/environ"; readFileSync(P);',
      'const P = "/proc/self/"; readFileSync(P + "environ");',
      'const dir = "/proc"; readFileSync(`${dir}/self/environ`);',
      "const P = `/proc/${process.pid}/environ`; readFileSync(P, \"utf8\");",
    ]) expect(wholeEnvReads([{ file: "x.test.ts", text }]), text).not.toEqual([]);
  });

  it("qa:TC missing AC1: an ordinary named read, a named only object and an unrelated `env` stay quiet", () => {
    for (const text of [
      "const url = process.env.TASKBOARD_URL;",
      "const e = { env: process.env.TASKBOARD_URL }; console.log(e.env);",
      'const target = "/tmp/x"; readFileSync(target);',
      "const config = { env: process.env.NODE_ENV }; send(config);",
      "const env: NodeJS.ProcessEnv = { ...process.env }; spawn(bin, args, { env, detached: true });",
    ]) expect(wholeEnvReads([{ file: "y.test.ts", text }]), text).toEqual([]);
  });
});

// REVIEW-2917 §4: the reviewer's method is a REAL file under a throwaway copy's tests/, then the same scan. These harnesses
// do exactly that: copy this tree's tests/ (excluding the two guard files) into a temp dir, drop one file per case, scan.
function withThrowawayTree<T>(body: (dir: string, drop: (file: string, text: string) => void) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sho-2917-"));
  try {
    // Copy tests/ INTO the temp dir, so the copy is `dir/tests/...`: the shape `scannedFiles` reports and `violations`
    // excludes the two guard files by. Only tests/ is copied; the guard never reads outside it.
    cpSync(TESTS_DIR, path.join(dir, TESTS_DIR), { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
    const tree = path.join(dir, TESTS_DIR);
    const drop = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      writeFileSync(path.join(tree, file), text);
    };
    return body(tree, drop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("REVIEW-2917: the scan runs against real files in a throwaway copy of tests/, not only strings", () => {
  it("qa:TC missing AC1: the tree at HEAD passes the scan (the guard is not vacuous)", () => {
    withThrowawayTree((tree) => {
      const files = scannedFiles(tree);
      expect(files.length, "files copied").toBeGreaterThan(50);
      expect(violations(files)).toEqual([]);
    });
  });

  // Each case from the review, as a real file on disk. Every one dumps or bypasses the environment, so every one must
  // be reported: a missed case fails here with the file name in the message.
  const ADVERSARIAL: [string, string][] = [
    ["zz-p1.ts", 'const P = "/proc/self/environ"; readFileSync(P);'],
    ["zz-p2.ts", 'const P = "/proc/self/"; readFileSync(P + "environ");'],
    ["zz-p3.ts", 'readFileSync(`${P}/self/environ`); const P = "/proc";'],
    ["zz-p4.ts", 'readFileSync(new URL("file:///proc/self/environ"));'],
    ["zz-p5.ts", 'readFileSync(["/proc","self","environ"].join("/"));'],
    ["zz-e1.ts", "const e = process.env; console.log(e);"],
    ["zz-e2.ts", 'console.log(process["env"]);'],
    ["zz-e3.ts", 'Object.keys(process["env"]);'],
    ["zz-e4.ts", "console.log(globalThis.process.env);"],
    ["zz-e5.ts", "const e = process.env; JSON.stringify(e);"],
    ["zz-e6.ts", "const { ...all } = process.env; console.log(all);"],
    ["zz-e7.ts", "Object.getOwnPropertyNames(process.env);"],
  ];

  for (const [file, text] of ADVERSARIAL) {
    it(`qa:TC missing AC1: a real file tests/${file} is reported: ${text}`, () => {
      withThrowawayTree((tree, drop) => {
        drop(file, text);
        const hits = violations(scannedFiles(tree)).filter((hit) => hit.file === path.join(tree, file));
        expect(hits, `${file} was not reported: ${text}`).not.toEqual([]);
      });
    });
  }
});
