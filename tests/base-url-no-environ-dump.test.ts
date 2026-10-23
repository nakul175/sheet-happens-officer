// SHO-2917 AC1 as a static proof: no file under tests/ reads the environment as a whole. A whole-environment read
// happens in one of two ways, and this file parses every test file (comments ignored) to refuse both:
//   1. The process image file (/proc/self/environ, /proc/<pid>/environ, /proc/self/cmdline), read through node:fs.
//   2. A spread, dump or listing of process.env itself (...process.env, process.env dump, Object.keys(process.env),
//      JSON.stringify(process.env), Object.assign({}, process.env), for (const k in process.env)).
// The file names the banned forms in its own patterns and examples, so the scan leaves this file out.
// It parses with the TypeScript compiler instead of matching one literal path, so a path built with `+`, ${...} or
// path.join is still caught, and `{ ...process.env, PORT }` (a deliberate per-key copy for a child process) is not
// flagged unless it is handed to a dump API or listed.
// No TC id is assigned on the issue. Follow-ups SHO-3031 and SHO-3032 are not exercised here (see BUG-2917.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SELF = path.join("tests", "base-url-no-environ-dump.test.ts");
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

/** True when the expression names the environ or cmdline file under /proc: by literal, template hole, or concatenation. */
function namesProcessImage(node: ts.Node): boolean {
  const ENVIRON = /\/proc\/.*(\/environ|\/cmdline)\b/;
  const rebuild = (inner: ts.Node): string => {
    if (ts.isStringLiteralLike(inner)) return inner.text;
    if (ts.isTemplateExpression(inner)) return inner.head.text + inner.templateSpans.map((span) => "${}" + span.literal.text).join("");
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return rebuild(inner.left) + rebuild(inner.right);
    // path.join("/proc", "self", "environ"): every argument is a piece of the path.
    if (ts.isCallExpression(inner)) return inner.arguments.map((argument) => (ts.isStringLiteralLike(argument) ? argument.text : "${}")).join("/");
    return "${}";
  };
  return ENVIRON.test(rebuild(node));
}

/** True when the expression IS the whole environment: `process.env`, or Object.keys(process.env) and friends. */
function isWholeEnv(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isWholeEnv(node.expression);
  // String(process.env), util.inspect(process.env), JSON.stringify(process.env): the argument is the environment.
  if (ts.isCallExpression(node) && node.arguments.length === 1 && /^(String|JSON\.stringify|util\.inspect|util\.format)$/.test(node.expression.getText())) return isWholeEnv(node.arguments[0]);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process";
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression.getText();
    const method = node.expression.name.text;
    // Object.keys(process.env), Object.entries(...), Object.values(...), Reflect.ownKeys(process.env)
    if (owner === "Object" && ["keys", "entries", "values"].includes(method) && node.arguments.length === 1) return isWholeEnv(node.arguments[0]);
    if (owner === "Reflect" && method === "ownKeys" && node.arguments.length === 1) return isWholeEnv(node.arguments[0]);
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
    const spawnEnvSpreads = new Set<ts.Node>();
    const envCopies = new Map<string, ts.Node>();
    const isSpawnCall = (node: ts.Node): node is ts.CallExpression => (ts.isCallExpression(node) || ts.isNewExpression(node)) && (
      (ts.isPropertyAccessExpression(node.expression) && CALLS.has(node.expression.name.text))
      || (ts.isIdentifier(node.expression) && CALLS.has(node.expression.text)));
    const spreadsIn = (node: ts.Node): ts.Node[] => {
      const out: ts.Node[] = [];
      const walk = (inner: ts.Node): void => {
        if (ts.isSpreadAssignment(inner) || ts.isSpreadElement(inner)) {
          if (isWholeEnv(inner.expression)) out.push(inner);
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
        && isWholeEnv(node.arguments[0])) report(node, 'whole environment copied');
      // 1. A spread of the whole environment: { ...process.env }, unless it is only the env of a child process.
      if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isWholeEnv(node.expression) && !spawnEnvSpreads.has(node)) {
        report(node, "spread of process.env");
      }
      if (ts.isCallExpression(node)) {
        // 3. A whole environment handed to a dump API: console.log(process.env), JSON.stringify(process.env)
        if (isDumpCall(node) && node.arguments.some((argument) => isWholeEnv(argument))) report(node, "whole environment dumped");
        if (ts.isPropertyAccessExpression(node.expression)) {
          const owner = node.expression.expression.getText();
          const method = node.expression.name.text;
          // 2. A whole environment copied elsewhere: Object.assign(target, process.env)
          if (owner === "Object" && method === "assign" && node.arguments.length > 1 && isWholeEnv(node.arguments[1])) {
            report(node, "whole environment copied");
          }
        }
      }
      // 4. A whole environment listed in place: Object.keys(process.env)
      if (ts.isCallExpression(node) && isWholeEnv(node)) report(node, "whole environment listed");
      if (ts.isForInStatement(node) && isWholeEnv(node.expression)) report(node, "whole environment iterated");
      // 5. The process image file read through node:fs, however the path is built.
      if (ts.isCallExpression(node) && node.arguments.some((argument) => namesProcessImage(argument))) report(node, "process image file read");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** The files under tests/ as { file, text }, leaving out this one file (it names the banned forms). */
export function scannedFiles(): { file: string; text: string }[] {
  return filesUnder(TESTS_DIR)
    .filter((file) => file !== SELF)
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

describe("qa:TC missing SHO-2917 AC1: no file under tests/ reads the environment as a whole", () => {
  it("qa:TC missing AC1: every test file parses as source and reads only named variables", () => {
    const files = scannedFiles();
    expect(files.length, "test files scanned").toBeGreaterThan(50);
    expect(wholeEnvReads(files)).toEqual([]);
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
