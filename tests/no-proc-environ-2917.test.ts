// APL-2917. No test file reads the process image of environment variables, so no run can load every secret at once.
// REVIEW-2917 R4: the tree scan now delegates to the single authoritative guard, `violations` in
// base-url-no-environ-dump.test.ts (which imports `environReaders` from here), so AC1/AC3 have one verdict, not two.
// AC1 at run time runs in base-url-env-2917.test.ts.
// No TC id is assigned on the issue.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { violations } from "./base-url-no-environ-dump.test";

const ENVIRON = ["", "proc", "self", "environ"].join("/"); // the banned path, spelled in pieces so this file is readable
// SHO-3031, SHO-3032. The scan paired "a proc piece somewhere" with "an environ piece somewhere", so a file that read
// /proc/cpuinfo and also served a route called "environ" was flagged, while '/pr' + 'oc/self/environ' -- the banned
// file, split inside the word -- was missed. A file is now judged one resolved path at a time: each expression is
// resolved the way it runs (string literals joined by +, template pieces and their ${...}, names bound by
// const/let/var, path.join) and the resolved path is matched against the one file that matters, proc/<x>/environ.
const RUN_TIME = "\u0000"; // one run-time value. It is not a separator, so /proc/${pid}/environ is still one path.
const PROC_ENVIRON_PATH = /\/proc\/[^/\s]+\/environ(?![A-Za-z0-9_])/;

/** One piece of an expression: a literal, the ${...} of a template, a name, or punctuation. */
type Token =
  | { kind: "text"; value: string; template?: boolean }
  | { kind: "interp"; source: string; template?: boolean }
  | { kind: "word"; value: string }
  | { kind: "punct"; value: string };

/** True for a piece of a template literal, whose neighbours follow it without a `+`. */
const isTemplatePiece = (t: Token | undefined) => !!t && (t.kind === "text" || t.kind === "interp") && t.template === true;

export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    // lstat, never stat (REVIEW-2917 F5): statSync follows a link, so a directory symlink under tests/ was traversed and
    // its target scanned. A symlink is now skipped outright — the guard scans the real files of this tree only, so a link
    // to a large or foreign tree cannot slow it, deepen it or pull in files that are not in scope.
    const info = lstatSync(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) out.push(...filesUnder(full));
    else if (/\.(c|m)?[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Splits source into the pieces that can make up a path, dropping the code around them. */
function tokensOf(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // Reads the literal that opens at the quote `i` points at, and leaves `i` past its closing quote.
  const quoted = (quote: string) => {
    let value = "";
    for (i += 1; i < source.length && source[i] !== quote; i++) {
      if (source[i] === "\\" && i + 1 < source.length) i++;
      value += source[i];
    }
    i++; // the closing quote
    return value;
  };
  // Reads the code inside ${...}, leaving `i` past its closing brace.
  const braced = () => {
    const start = i;
    let depth = 1;
    while (i < source.length) {
      const c = source[i];
      if (c === "'" || c === '"' || c === "`") { quoted(c); continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return source.slice(start, i++);
      i++;
    }
    return source.slice(start);
  };
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === `"` || c === "'") { out.push({ kind: "text", value: quoted(c) }); continue; }
    if (c === "`") {
      i++;
      let value = "";
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < source.length) { value += source[i + 1]; i += 2; continue; }
        if (source[i] === "$" && source[i + 1] === "{") {
          if (value) out.push({ kind: "text", value, template: true });
          value = "";
          i += 2;
          out.push({ kind: "interp", source: braced(), template: true });
          continue;
        }
        value += source[i++];
      }
      i++; // the closing backtick
      if (value) out.push({ kind: "text", value, template: true });
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      out.push({ kind: "word", value: source.slice(start, i) });
      continue;
    }
    out.push({ kind: "punct", value: c });
    i++;
  }
  return out;
}

type Value = { value: string; next: number };
type Bindings = Map<string, string>;

/** Skips `name.member(...)[index]` after a name that is not a bound path, so the `+` after it is still reached. */
function afterChain(tokens: Token[], at: number): number {
  let i = at + 1;
  for (;;) {
    const t = tokens[i];
    if (!t) return i;
    if (t.kind === "punct" && t.value === ".") {
      i++;
      if (tokens[i]?.kind === "word") i++;
      continue;
    }
    if (t.kind === "punct" && t.value === "?") {
      const dot = tokens[i + 1];
      if (!dot || dot.kind !== "punct" || dot.value !== ".") return i;
      i += 2;
      if (tokens[i]?.kind === "word") i++;
      continue;
    }
    if (t.kind === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) {
      let depth = 0;
      do {
        const c = tokens[i];
        if (c.kind === "punct" && (c.value === "(" || c.value === "[" || c.value === "{")) depth++;
        else if (c.kind === "punct" && (c.value === ")" || c.value === "]" || c.value === "}")) depth--;
        i++;
      } while (i < tokens.length && depth > 0);
      continue;
    }
    return i;
  }
}

/** path.join(...) joins its arguments with "/", exactly as the call does. */
function joinAt(tokens: Token[], at: number, bindings: Bindings, depth: number): Value {
  const parts: string[] = [];
  let i = at;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === ")") { i++; break; }
    const arg = concatAt(tokens, i, bindings, depth);
    if (!arg) {
      if (t.kind !== "punct") parts.push(RUN_TIME); // an argument we cannot follow still takes a place
      i++;
      continue;
    }
    parts.push(arg.value);
    i = arg.next;
    const comma = tokens[i];
    if (comma && comma.kind === "punct" && comma.value === ",") i++;
  }
  return { value: parts.join("/"), next: i };
}

/**
 * An array literal joined by `.join(sep)`, resolved the way it runs: `["/proc","self","environ"].join("/")` is the
 * banned path. REVIEW-2917's own adversarial case is written this way, so the resolver has to read it.
 */
function arrayJoinAt(tokens: Token[], at: number, bindings: Bindings, depth: number): Value | null {
  const parts: string[] = [];
  let i = at + 1;
  let closed = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === "]") { closed = true; i++; break; }
    const part = concatAt(tokens, i, bindings, depth);
    if (!part) return null; // an element we cannot follow: not a path this guard can resolve
    parts.push(part.value);
    i = part.next;
    const comma = tokens[i];
    if (comma && comma.kind === "punct" && comma.value === ",") i++;
  }
  if (!closed) return null;
  const [dot, join, open] = [tokens[i], tokens[i + 1], tokens[i + 2]];
  if (!(dot?.kind === "punct" && dot.value === "." && join?.kind === "word" && join.value === "join" && open?.kind === "punct" && open.value === "(")) return null;
  let separator = ","; // Array.prototype.join's default
  const arg = termAt(tokens, i + 3, bindings, depth);
  if (arg) {
    separator = arg.value;
    i = arg.next;
  } else {
    i += 3;
  }
  const close = tokens[i];
  if (close && close.kind === "punct" && close.value === ")") i++;
  return { value: parts.join(separator), next: i };
}

/** Reads one value at `at`: a literal, a template, a bound name, path.join(...), or a parenthesised value. */
function termAt(tokens: Token[], at: number, bindings: Bindings, depth: number): Value | null {
  const t = tokens[at];
  if (!t) return null;
  if (t.kind === "text") return { value: t.value, next: at + 1 };
  if (t.kind === "interp") return { value: valueOf(t.source, bindings, depth + 1), next: at + 1 };
  if (t.kind === "punct" && t.value === "(") {
    const inner = concatAt(tokens, at + 1, bindings, depth);
    const next = inner ? inner.next : at + 1;
    const close = tokens[next];
    return { value: inner ? inner.value : RUN_TIME, next: close && close.kind === "punct" && close.value === ")" ? next + 1 : next };
  }
  if (t.kind === "punct" && t.value === "[") return arrayJoinAt(tokens, at, bindings, depth);
  if (t.kind !== "word") return null;
  if (t.value === "path") {
    const [dot, join, open] = [tokens[at + 1], tokens[at + 2], tokens[at + 3]];
    if (dot?.kind === "punct" && dot.value === "." && join?.kind === "word" && join.value === "join" && open?.kind === "punct" && open.value === "(") {
      return joinAt(tokens, at + 4, bindings, depth);
    }
  }
  const bound = bindings.get(t.value);
  const next = tokens[at + 1];
  // A member, a call or an index after the name means the value is no longer the name's literal.
  const chained = next && next.kind === "punct" && (next.value === "." || next.value === "?" || next.value === "(" || next.value === "[");
  if (bound !== undefined && !chained) return { value: bound, next: at + 1 };
  return { value: RUN_TIME, next: afterChain(tokens, at) };
}

/** Reads `a + b + c`, so the pieces a split literal puts in different tokens are one path again. */
function concatAt(tokens: Token[], at: number, bindings: Bindings, depth: number): Value | null {
  let value = "";
  let i = at;
  let any = false;
  for (;;) {
    const part = termAt(tokens, i, bindings, depth);
    if (!part) break;
    value += part.value;
    i = part.next;
    any = true;
    const plus = tokens[i];
    if (plus && plus.kind === "punct" && plus.value === "+") { i++; continue; }
    // The pieces of one template literal follow each other without an operator.
    if (isTemplatePiece(tokens[i - 1]) && isTemplatePiece(tokens[i])) continue;
    break;
  }
  return any ? { value, next: i } : null;
}

/** The value of the code inside ${...}: a path expression that resolves completely, or one run-time value. */
function valueOf(source: string, bindings: Bindings, depth: number): string {
  if (depth > 8) return RUN_TIME;
  const inner = tokensOf(source);
  const whole = concatAt(inner, 0, bindings, depth);
  return whole && whole.next >= inner.length ? whole.value : RUN_TIME;
}

/** The names a file binds to a path expression, such as `const dir = "/proc/self/";`. */
function bindingsOf(tokens: Token[], known: Bindings): Bindings {
  const out = new Map(known);
  for (let i = 0; i + 3 < tokens.length; i++) {
    const [keyword, name, equals] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    const declares = keyword.kind === "word" && (keyword.value === "const" || keyword.value === "let" || keyword.value === "var");
    if (!declares || name.kind !== "word" || equals.kind !== "punct" || equals.value !== "=") continue;
    const value = concatAt(tokens, i + 3, out, 0);
    if (!value) continue;
    const end = tokens[value.next];
    if (end && !(end.kind === "punct" && (end.value === ";" || end.value === "," || end.value === ")"))) continue;
    if (!value.value.split(RUN_TIME).join("")) continue; // only a run-time value: nothing to learn
    out.set(name.value, value.value);
  }
  return out;
}

/** Every path expression in a file, resolved with each run-time value standing in as one character. */
function pathsIn(text: string): string[] {
  const tokens = tokensOf(text);
  let bindings: Bindings = new Map();
  // A name may be built from another (`const b = a + "/self"`), so resolve the declarations a few times over.
  for (let pass = 0; pass < 3; pass++) bindings = bindingsOf(tokens, bindings);
  const out: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const first = tokens[at];
    // `[` may open an array literal joined by `.join(...)`; every other punctuation cannot start a path.
    if (first.kind === "punct" && first.value !== "[") continue;
    const path = concatAt(tokens, at, bindings, 0);
    if (path) out.push(path.value);
  }
  return out;
}

/**
 * The test-file paths under tests/ whose source reads the process image of environment variables. Each expression is
 * judged on its own resolved value, so a benign /proc read beside a "/environ" route is not flagged, and a path split
 * inside "proc" is caught. The whole-file spelling of the banned path still counts, so the one file this guard was
 * written for stays caught however it is assembled.
 */
export function environReaders(files: { file: string; text: string }[]) {
  return files
    .filter(({ text }) => text.includes(ENVIRON) || pathsIn(text).some((value) => PROC_ENVIRON_PATH.test(value)))
    .map(({ file }) => file);
}

describe("qa:TC missing APL-2917: no test file reads the whole process environment", () => {
  it("qa:TC missing AC3: no file under tests/ reads the process environment image", () => {
    // Delegated to the one authoritative guard, which is a superset of the scan that used to live here: it unions this
    // file's `environReaders` with the whole-environment scan, and it already leaves both guard files out.
    const files = filesUnder("tests").map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(files.length).toBeGreaterThan(50);
    expect(violations(files)).toEqual([]);
  });

  it("qa:TC missing AC3: the check catches each way of naming that file", () => {
    for (const text of [
      `readFileSync("${ENVIRON}")`,
      "readFileSync(`/proc/${process.pid}/environ`)",
      `readFileSync(path.join("/proc", "self", "environ"))`,
      `fs.readFileSync('/proc/1/environ', "latin1")`,
      // String concatenation (Pam, D1 on f263aad).
      `readFileSync("/proc/" + process.pid + "/environ")`,
      `readFileSync('/proc/self' + '/environ')`,
      "readFileSync(`/proc/${process.pid}` + `/environ`)",
      `const dir = "/proc/self/"; readFileSync(dir + "environ")`,
      // Template literals with the path split across pieces or inside ${...}.
      "readFileSync(`${\"/proc/self/\" + \"environ\"}`)",
      "readFileSync(`/proc/self/environ${suffix}`)",
      // A template that joins a directory variable to the file name (Pam, D1 on a935b24).
      'const dir = "/proc/self/"; readFileSync(`${dir}environ`)',
      'const procDir = "/proc/1/"; readFileSync(`${procDir}environ${suffix}`)',
      'const root = "/proc"; readFileSync(`${root}/${pid}/environ`)',
      "readFileSync(path.join(`/proc`, `self`, `environ`))",
    ]) {
      expect(environReaders([{ file: "x.ts", text }]), text).toEqual(["x.ts"]);
    }
    for (const text of [
      `readFileSync("/proc/self/stat")`,
      `const msg = "the environment is not read";`,
      "`${environment}/x`",
      `env.BASE_URL + "/environments"`,
      // No proc path piece in the file (Pam, D3 on a935b24): a route and a test title.
      `app.get("/environ", handler)`,
      `it('environ', () => {})`,
    ]) {
      expect(environReaders([{ file: "y.ts", text }]), text).toEqual([]);
    }
  });

  // SHO-3031, SHO-3032. Both tickets' own examples, checked against the guard as it stood at this head, kept here so
  // these cases are proven to fail on that implementation and not merely to pass on the fix. At this head a file was
  // still judged by "a proc piece somewhere plus an environ piece somewhere", and every proc/environ piece had to be
  // written whole -- so a benign /proc read beside an /environ route was flagged, and a path split inside the word
  // was missed.
  const legacyEnvironReaders = (files: { file: string; text: string }[]) => {
    // The guard exactly as it stood at 243a3bb, kept verbatim so the cases below are provably red on it.
    const procEnviron = new RegExp(["/proc/", "[^\\s\"'`]*", "/environ\\b"].join(""));
    const environPart = new RegExp(["[\"'`]environ", "[\"'`]"].join(""));
    const environSegment = /["'`/}]environ(?=["'`/$])/;
    const procSegment = /["'`/]proc(?=["'`/$])/;
    return files
      .filter(
        ({ text }) =>
          text.includes(ENVIRON) ||
          procEnviron.test(text) ||
          (procSegment.test(text) && (environPart.test(text) || environSegment.test(text))),
      )
      .map(({ file }) => file);
  };

  it("qa:TC missing AC3: does not flag a proc path beside an unrelated environ route or title (SHO-3031)", () => {
    // The ticket's own example: a harmless "/proc/cpuinfo" read, and apart from it an "/environ" route or title.
    const benign = [
      `const cpu = readFileSync("/proc/cpuinfo", "utf8"); app.get("/environ", handler)`,
      `const cpu = "/proc/cpuinfo"; it('environ', () => { expect(cpu).toBeTruthy() })`,
      `const s = "/proc/1/stat"; expect(s).toContain("environ")`,
      `const dir = "/proc/1/"; app.get(\`/environ\`, handler)`,
    ];
    for (const text of benign) {
      // The pre-fix guard flagged every one of these; that is the defect these cases pin.
      expect(legacyEnvironReaders([{ file: "y.ts", text }]), text).toEqual(["y.ts"]);
      expect(environReaders([{ file: "y.ts", text }]), text).toEqual([]);
    }
  });

  // SHO-3031, at the level the ticket describes: a real file on disk, one per direction. The string cases above judge
  // the resolver; this one writes the ticket's own file beside a file that really builds the path, reads both back and
  // asks for one verdict over the pair, so the false positive and the true positive are pinned together.
  it("qa:TC missing AC3: one real file on disk per direction (SHO-3031)", () => {
    // The ticket's file: a harmless proc path piece, and apart from it an "/environ" route and an 'environ' title.
    const BENIGN = [
      `import { readFileSync } from "node:fs";`,
      `export const routes = { "/environ": () => "ok" };`,
      `it('environ', () => {`,
      `  const cpu = readFileSync("/proc/cpuinfo", "utf8");`,
      `  expect(cpu.length).toBeGreaterThan(0);`,
      `});`,
    ].join("\n");
    // The file this guard exists for, assembled so the banned path is never written whole.
    const READER = [
      `import { readFileSync } from "node:fs";`,
      `export const image = () => readFileSync("/proc/" + "self" + "/environ", "utf8");`,
    ].join("\n");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sho-3031-"));
    try {
      const files = [
        { name: "benign.ts", text: BENIGN },
        { name: "reader.ts", text: READER },
      ].map(({ name, text }) => {
        writeFileSync(path.join(dir, name), text);
        return { file: path.join(dir, name), text: readFileSync(path.join(dir, name), "utf8") };
      });
      // The ticket's file is not flagged: it never builds a /proc/<pid|self>/environ path.
      expect(environReaders([files[0]])).toEqual([]);
      // The reader is flagged, from the same file on disk.
      expect(environReaders([files[1]]).map((file) => path.basename(file))).toEqual(["reader.ts"]);
      // The one authoritative guard agrees, in both of its passes (the resolver and the AST pass).
      expect(violations(files).map((v) => path.basename(v.file))).toEqual(["reader.ts", "reader.ts"]);
      // A "fix" that deleted the resolution pass would leave only the whole-file spelling, which neither file contains:
      // that guard would pass the benign case above and miss the reader. The clause cannot be deleted.
      expect([BENIGN, READER].map((text) => text.includes(ENVIRON))).toEqual([false, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("qa:TC missing AC3: flags the mid-word splits the pre-fix guard missed (SHO-3032)", () => {
    // The ticket's own two examples: the banned file assembled without ever writing "proc" or "environ" whole.
    for (const text of [`readFileSync('/pr' + 'oc/self/environ')`, `readFileSync("/proc/self/env" + "iron")`]) {
      expect(legacyEnvironReaders([{ file: "x.ts", text }]), text).toEqual([]);
      expect(environReaders([{ file: "x.ts", text }]), text).toEqual(["x.ts"]);
    }
    // The same split at other points in the path, and inside a template's ${...}.
    for (const text of [
      `readFileSync("/proc/sel" + "f/environ")`,
      `const p = "/pro"; readFileSync(p + "c/self/environ")`,
      "readFileSync(`/proc/self/env${'iron'}`)",
    ]) {
      expect(environReaders([{ file: "x.ts", text }]), text).toEqual(["x.ts"]);
    }
  });

  // SHO-3032, second half: the ticket asks for the LIMIT to be decided, not for a wider rule. The resolver already
  // catches the ticket's own split (the test above) because it follows the composition a source file can state:
  // literals joined by `+`, template pieces and their ${...}, const/let/var names bound to a path, path.join, and an
  // array literal joined by .join. What it does not do is evaluate code. The rows below are that boundary, MEASURED at
  // this head: each `missed` row is a way to build the banned file that the authoritative guard does not report, and
  // each is missed by the pre-fix guard too, so it is one shared limit, not a regression from the resolver.
  //
  // Why the pin and not a wider rule: the one cheap wider rule is the rule SHO-3031 removed - "a proc piece somewhere
  // plus an environ piece somewhere" - which flags a file that reads /proc/cpuinfo and serves a route called
  // "environ" (the test above). The other option, following every call and returned value, is a partial evaluator:
  // unbounded to write and still beaten by one more indirection. A run-time fs spy is the stronger control and is
  // recorded as follow-up, not built here (see the LIMITS note on SHO-3032). So the reach stays as it is and is
  // stated in a test: these rows are documented misses, not a clean bill. If one is later taught to the resolver, it
  // moves to `caught` in the same commit - this test is the record of the decision.
  it("qa:TC missing AC3: states the boundary of the source scan (SHO-3032)", () => {
    // Static composition the guard does resolve: the authoritative verdict must be a violation for each.
    const caught = [
      // The ticket's own split, inside the word.
      `readFileSync('/pr' + 'oc/self/environ')`,
      // The shape SHO-2771 removed from the mode tier at e86f239: the pid is a run-time value and the PATH SHAPE is
      // what is matched, so guessing a pid does not help a reader hide.
      "readFileSync(`/proc/${pid}/environ`)",
      // The same shape from an enumeration of the process table: "find a process's environment" in one line.
      'for (const p of readdirSync("/proc")) readFileSync(`/proc/${p}/environ`)',
      // Names bound to the pieces in more than one statement (the resolver knows the bindings, not just literals).
      `const a = "/pr"; const b = "oc/self/environ"; readFileSync(a + b)`,
      // An array literal joined with no separator.
      `readFileSync(["/pr", "oc/self", "/environ"].join(""))`,
      // A call around a finished literal: the resolver stops at the call, the AST pass rebuilds the argument.
      `readFileSync(String("/pr" + "oc/self/environ"))`,
    ];
    for (const text of caught) {
      expect(violations([{ file: "x.ts", text }]).length, text).toBeGreaterThan(0);
    }
    // Composition the guard does not resolve. Both guards miss these, so it is a limit of a source scan, not a
    // difference between the old and the new one.
    const missed: [string, string][] = [
      ["two declarators in one statement: only the first is bound", `const a = "/pr", b = "oc/self/environ"; readFileSync(a + b)`],
      ["a method other than path.join/.join, here .concat", `readFileSync("/pr".concat("oc/self/environ"))`],
      ["an array held in a name, then joined", `const parts = ["/pr", "oc/self"]; readFileSync(parts.join("") + "/environ")`],
      ["a property of a local object", `const o = { p: "/pr" }; readFileSync(o.p + "oc/self/environ")`],
      ["a path computed at run time, here String.fromCharCode", `readFileSync(String.fromCharCode(47,112,114,111,99,47,115,101,108,102,47,101,110,118,105,114,111,110))`],
      ["a path decoded at run time, here base64", `readFileSync(Buffer.from("L3Byb2Mvc2VsZi9lbnZpcm9u", "base64").toString())`],
      ["a piece that comes from outside the file", `readFileSync(process.argv[2] + "oc/self/environ")`],
    ];
    for (const [why, text] of missed) {
      expect(violations([{ file: "x.ts", text }]).length, why).toBe(0);
      expect(legacyEnvironReaders([{ file: "x.ts", text }]), why).toEqual([]);
    }
    // The seven rows above are the whole documented gap at this head, so a widening shows up as a red count here.
    expect(missed).toHaveLength(7);
  });

});
