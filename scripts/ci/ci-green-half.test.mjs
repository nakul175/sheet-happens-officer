// The "…and CI is green" half of seven AC clauses: 2917 AC2, 2951 AC3, 3000 AC3, 3010 AC4, 3011 AC4, 3012 AC4,
// 3013 AC4 (W133-REPORT.md §4.3; AC-TRUTH-TABLE-35.md). Every one of those clauses is "a test covers it, and CI is
// green", and the first half has a receipt file. Nothing asserted the second half.
//
// "CI is green" is two different claims and only one of them is a repo fact:
//
//   GREEN-CONCLUSION   the CI provider's conclusion for a head SHA is `success`. A hosted-run fact: it needs a provider
//                      token and a network call at test time, so it is NOT asserted here and cannot be faked by reading
//                      a file. W161-REPORT.md carries it as NOT-TESTABLE-IN-REPO for each of the seven.
//   WIRED              the part a repo can be wrong about, and today nobody checks: that the run called "CI" executes
//                      the very file the clause's first half names, that the step cannot fail soft, that the workflow
//                      runs at all on a pull request, and that it checks out the PR head SHA rather than a merge
//                      commit. Break any one of those and "CI is green" is true while saying nothing about the clause —
//                      which is exactly the state where the unenforced half of the AC hides.
//
// W171-REPORT.md §4 graded the first cut of this file: several rows were regexes over YAML *text* and stayed green
// under a mutation that broke the property (a `types: [closed]` trigger, `continue-on-error: ${{ … }}`, `if: false`
// on the unit-test step, a `ref:` on a step that ignores it). W180 reads the parsed workflow instead of the text, and
// names the residue TEXT-ONLY where a repo check genuinely cannot reach the claim. Every assertion below is one of:
//
//   BEHAVIOURAL   it reads a structure (a parsed trigger set, a parsed step) and goes red when the structure loses the
//                 property, whatever the spelling.
//   TEXT-ONLY     it can only compare text or a constant. The test name says TEXT-ONLY and the comment above it says
//                 why, so a reader is not misled into thinking the claim is enforced.
//
// This file is itself run by `.github/workflows/ci.yml` ("Node tests for scripts/ci"), before `npm ci`, from `node:test`
// and node builtins only, so it needs no dependency and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI_TEXT = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const DEFAULT_CONFIG = readFileSync(join(ROOT, "vitest.config.mts"), "utf8");

/** One row per clause: the ticket, the clause, its second half, and the file that enforces the first half. */
const CLAUSES = [
  { ticket: "2917", clause: "AC2", half: "…CI green", receipt: "tests/base-url-env-2917.test.ts" },
  { ticket: "2951", clause: "AC3", half: "…tests cover both, CI green", receipt: "tests/usage-month-figure-2951.test.ts" },
  { ticket: "3000", clause: "AC3", half: "CI is green", receipt: "tests/staging-local-only-list.test.ts" },
  { ticket: "3010", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/concierge-echo.test.ts" },
  { ticket: "3011", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/apl-2742.test.ts" },
  { ticket: "3012", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/usage-percent-default-cap.test.ts" },
  { ticket: "3013", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/usage-ceiling.test.tsx" },
];

// ---------------------------------------------------------------------------------------------------------------
// A YAML subset parser: block mappings, block sequences, flow sequences/mappings, block scalars, comments. No
// dependency, because this file runs before `npm ci`. It is deliberately not a general YAML parser — it is the
// shape `.github/workflows/ci.yml` uses — and every test below fails loudly if that shape is gone (a missing
// trigger or step reads as `undefined`, never as a silent pass).
// ---------------------------------------------------------------------------------------------------------------

/**
 * A line with its comment removed, quotes honoured (`ref: "a # b"` keeps the `#`). A `#` starts a comment only at
 * the start of a line or after whitespace, which is YAML's rule.
 */
function stripComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, "");
}

function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/** The value side of `key: value` as a JS value: flow sequence, flow mapping, or scalar. */
function inlineValue(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((part) => unquote(part))
      .filter((part) => part !== "");
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const out = {};
    const body = v.slice(1, -1).trim();
    if (body === "") return out;
    for (const pair of body.split(",")) {
      const colon = pair.indexOf(":");
      if (colon === -1) out[unquote(pair)] = null;
      else out[unquote(pair.slice(0, colon))] = inlineValue(pair.slice(colon + 1));
    }
    return out;
  }
  return unquote(v);
}

const KEY_LINE = /^(?:"([^"]*)"|'([^']*)'|([^:]+?))\s*:(?:\s+(.*))?$/;

/** Parse the workflow text into plain objects/arrays. Exported so a probe can inspect exactly what the tests read. */
export function parseWorkflow(text) {
  const lines = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const body = stripComment(raw);
    if (body.trim() === "") continue;
    lines.push({ n: i + 1, body, indent: body.length - body.trimStart().length });
  }
  let at = 0;

  /** The value of a `key:` line: inline scalar/flow, a block scalar, or a nested block. */
  function valueOf(inline, keyIndent) {
    if (/^[|>][+-]?$/.test(inline.trim())) {
      const start = at;
      while (at < lines.length && lines[at].indent > keyIndent) at++;
      return lines
        .slice(start, at)
        .map((l) => l.body)
        .join("\n");
    }
    if (inline.trim() !== "") return inlineValue(inline);
    if (at < lines.length && lines[at].indent > keyIndent) return block(lines[at].indent);
    return null;
  }

  function block(indent) {
    const head = lines[at].body.trim();
    if (head === "-" || head.startsWith("- ")) return sequence(indent);
    return mapping(indent, {});
  }

  function mapping(indent, seed) {
    const obj = seed;
    while (at < lines.length) {
      const line = lines[at];
      if (line.indent !== indent) break;
      const m = line.body.trim().match(KEY_LINE);
      if (!m) break;
      const key = m[1] ?? m[2] ?? m[3].trim();
      at++;
      obj[key] = valueOf(m[4] ?? "", indent);
    }
    return obj;
  }

  function sequence(indent) {
    const arr = [];
    while (at < lines.length) {
      const line = lines[at];
      if (line.indent !== indent) break;
      const text = line.body.trim();
      if (!(text === "-" || text.startsWith("- "))) break;
      const afterDash = line.body.slice(line.body.indexOf("-") + 1);
      const innerIndent = indent + 1 + (afterDash.length - afterDash.trimStart().length);
      const inner = afterDash.trim();
      at++;
      if (inner === "") {
        arr.push(at < lines.length && lines[at].indent > indent ? block(lines[at].indent) : null);
        continue;
      }
      const pair = inner.startsWith("[") || inner.startsWith("{") ? null : inner.match(KEY_LINE);
      if (pair) {
        const key = pair[1] ?? pair[2] ?? pair[3].trim();
        const item = {};
        item[key] = valueOf(pair[4] ?? "", innerIndent);
        arr.push(mapping(innerIndent, item));
      } else {
        arr.push(inlineValue(inner));
      }
    }
    return arr;
  }

  return mapping(0, {});
}

// ---------------------------------------------------------------------------------------------------------------
// What the parsed workflow says. `undefined` anywhere here is a failure in a test below, never a silent pass.
// ---------------------------------------------------------------------------------------------------------------

/** The `on:` triggers as a Map of name -> its options (`null` when the trigger has no options block). */
export function triggersOf(workflow) {
  const on = workflow.on ?? workflow[true]; // a YAML 1.1 reader makes a bare `on` the boolean true
  const map = new Map();
  if (on === null || on === undefined) return map;
  if (typeof on === "string") {
    for (const name of on.split(",").map((s) => s.trim())) if (name) map.set(name, null);
    return map;
  }
  if (Array.isArray(on)) {
    for (const name of on) map.set(String(name), null);
    return map;
  }
  for (const [name, options] of Object.entries(on)) map.set(name, options);
  return map;
}

/** The pull-request activity types a `pull_request:` trigger fires on. No `types:` means GitHub's default set. */
export const DEFAULT_PR_TYPES = ["opened", "synchronize", "reopened"];

export function prTypes(options) {
  if (options === null || options === undefined) return DEFAULT_PR_TYPES;
  if (typeof options === "string") return DEFAULT_PR_TYPES; // `pull_request: ~`, or a scalar fudge
  const types = options.types;
  if (types === undefined || types === null) return DEFAULT_PR_TYPES;
  return (Array.isArray(types) ? types : [types]).map(String);
}

/**
 * True when the trigger starts a run on a pull-request HEAD: `opened` (the PR is opened) and `synchronize` (a commit
 * is pushed to it). `closed` alone — or any set without both — means no run ever sees a branch head, so a "CI is
 * green" conclusion for that head SHA does not exist. This is the predicate: the test below applies it to ci.yml,
 * and the one after applies it to the shapes GitHub documents, so the predicate is checked against its own meaning.
 */
export const runsOnPrHead = (options) => {
  const types = prTypes(options);
  return types.includes("opened") && types.includes("synchronize");
};

/** Every job step in the workflow as { jobName, index, step }, so a test keys on a parsed step, not on text. */
export function stepsOf(workflow) {
  const out = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [index, step] of (job?.steps ?? []).entries()) out.push({ jobName, index, step: step ?? {} });
  }
  return out;
}

// Parsed after the parser itself is defined: the module-level reads below depend on it, and a `const` used by a
// function that runs during module evaluation would not be initialized yet.
const WORKFLOW = parseWorkflow(CI_TEXT);
const STEPS = stepsOf(WORKFLOW);
const TRIGGERS = triggersOf(WORKFLOW);

/** The step whose parsed `name:` is exactly this one, or undefined. */
const stepNamed = (name) => STEPS.find((s) => s.step.name === name);

/** A step's own script. Empty when it has no `run:` — never a `with:` value and never a comment. */
const scriptOf = (step) => (typeof step?.run === "string" ? step.run : "");

/** The string entries of `key: [ ... ]` in a vitest config, without the spreads (same idiom as browser-tier-specs.test.mjs). */
function entriesIn(source, key) {
  const start = source.indexOf(`${key}: [`);
  assert.notEqual(start, -1, `no ${key} array in the config`);
  const body = source.slice(start + `${key}: [`.length).split("]")[0];
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const EXCLUDED = entriesIn(DEFAULT_CONFIG, "exclude");

/** A glob from the config (`*`, `**`) as a regex over a repo-relative path. */
function globRe(pattern) {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** The paths the default config keeps out of `npm test` that match this file, if any. */
const excludedBy = (file) => EXCLUDED.filter((pattern) => globRe(pattern).test(file));

/**
 * TEXT-ONLY: a mirror of `configDefaults.include` in `vitest/config`, not an import of it — this file runs before
 * `npm ci` and may not import vitest. It can only assert that a name has the shape vitest's default pattern
 * collects. That the config really keeps the default (no `include:` override) is a separate PROPERTY, asserted in
 * the per-clause rows.
 */
const DEFAULT_INCLUDE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

/** Every `continue-on-error` in the file with its value, comments excluded. */
function continueOnErrorValues(text) {
  const hits = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = stripComment(raw);
    if (!/continue-on-error/i.test(line)) continue;
    const m = line.match(/continue-on-error["']?\s*:\s*(.*)$/i);
    // The value as written, so the failure message shows the exact spelling that was found.
    hits.push({ line: i + 1, value: (m ? m[1] : "").trim() });
  }
  return hits;
}

/**
 * Shell idioms that turn a failed command into exit 0, so the step reports success for a failure.
 *
 * SCOPE, declared: these are applied only to the `Unit tests` step. A file-wide ban is not attempted, because three
 * diagnostic steps in ci.yml legitimately swallow (`npx playwright test --list … || true` to read its output, and two
 * `tail server.log … || true` lines). A rule with an allow-list of those three would look like enforcement of every
 * step while enforcing three exceptions, which is worse than saying plainly what this covers. A `|| true` added to
 * `Build` would therefore NOT redden this file — that is a gap, recorded here rather than hidden.
 */
const SHELL_SWALLOWS = [
  /\|\|\s*(?:true|:)\s*(?:$|[;&|)])/,
  /\|\|\s*exit\s+0\b/,
  /\bset\s+\+e\b/,
  /;\s*exit\s+0\s*$/m,
];

// ---------------------------------------------------------------------------------------------------------------
// Guard: the tests below read structures. If the parse ever comes back empty they must fail, not pass vacuously.
// ---------------------------------------------------------------------------------------------------------------

test("the parser read ci.yml: triggers, jobs and job steps are all non-empty", () => {
  assert.ok(TRIGGERS.size > 0, "no `on:` triggers were parsed out of ci.yml");
  assert.ok(Object.keys(WORKFLOW.jobs ?? {}).length > 0, "no `jobs:` were parsed out of ci.yml");
  assert.ok(STEPS.length > 10, `only ${STEPS.length} job steps were parsed out of ci.yml`);
  assert.ok(STEPS.every((s) => typeof s.step === "object" && s.step !== null), "a parsed step is not a mapping");
});

// ---------------------------------------------------------------------------------------------------------------
// C1 — TEXT-ONLY. The clause list is this file's own constant compared with a literal, so no change to the workflow,
// the config or a receipt can falsify it; only `existsSync` is falsifiable, and only about existence, never about
// content. W171 §2 W1 showed a deleted receipt left the per-clause row green, so existence is now also asserted
// there. There is no repo fact that says "these seven clauses are the clauses"; that lives in the ticket tracker.
// ---------------------------------------------------------------------------------------------------------------

test("TEXT-ONLY (clause list is this file's own constant): the seven clauses are the ones W133 §4.3 lists", () => {
  assert.deepEqual(
    CLAUSES.map((c) => `${c.ticket} ${c.clause}`),
    ["2917 AC2", "2951 AC3", "3000 AC3", "3010 AC4", "3011 AC4", "3012 AC4", "3013 AC4"],
  );
  for (const { ticket, receipt } of CLAUSES) {
    assert.ok(existsSync(join(ROOT, receipt)), `${ticket}: ${receipt} does not exist`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// C2 — BEHAVIOURAL. W171 §2 W2: add `types: [closed]` under `pull_request:` and the regex on the text stayed green,
// while no run would ever see a branch head again. The assertion now reads the parsed trigger and asks which PR
// activity events it fires on.
// ---------------------------------------------------------------------------------------------------------------

test("C2 CI runs on the PULL-REQUEST HEAD: pull_request fires on opened and synchronize, not only on close", () => {
  assert.ok(TRIGGERS.has("pull_request"), "ci.yml has no pull_request trigger, so a branch head gets no run");
  const types = prTypes(TRIGGERS.get("pull_request"));
  assert.ok(
    runsOnPrHead(TRIGGERS.get("pull_request")),
    `the pull_request trigger fires on [${types.join(", ")}]; a run on a PR head needs opened and synchronize. ` +
      "A `types:` list without them (e.g. [closed]) runs only after the branch is already gone.",
  );
});

/** The predicate C2 relies on, against the trigger shapes GitHub documents — so C2 cannot pass by accident. */
test("C2's predicate: the shapes GitHub honours, including the ones W171 found it could not tell apart", () => {
  // No `types:` at all is the default set: opened, synchronize, reopened.
  assert.equal(runsOnPrHead(null), true, "a bare pull_request: trigger runs on the PR head");
  assert.equal(runsOnPrHead({}), true, "pull_request: {} runs on the PR head");
  assert.equal(runsOnPrHead({ branches: ["main"] }), true, "a branch filter still runs on the PR head");
  assert.deepEqual(prTypes({ types: ["opened", "synchronize"] }), ["opened", "synchronize"]);
  assert.equal(runsOnPrHead({ types: ["opened", "synchronize", "reopened"] }), true);
  // The mutation W171 §2 W2 proved green: closed-only.
  assert.equal(runsOnPrHead({ types: ["closed"] }), false, "closed-only must be rejected");
  assert.equal(runsOnPrHead({ types: ["closed", "labeled"] }), false, "close and label events are not head runs");
  assert.equal(runsOnPrHead({ types: ["opened"] }), false, "opened alone misses every push to the PR");
  assert.equal(runsOnPrHead({ types: ["synchronize"] }), false, "synchronize alone misses the first head");
});

/** W171 also found the old regex over-strict: it reddened when `on:` keys were re-ordered. Parsing is order-free. */
test("C2 is independent of `on:` key order and of the scalar/list trigger shorthand", () => {
  const reordered = parseWorkflow("on:\n  workflow_dispatch:\n  pull_request:\n");
  assert.ok(triggersOf(reordered).has("pull_request"), "key order must not decide whether the trigger exists");
  const scalar = parseWorkflow("on: pull_request\n");
  assert.ok(triggersOf(scalar).has("pull_request"), "the `on: pull_request` shorthand must count");
  const list = parseWorkflow("on: [push, pull_request]\n");
  assert.ok(triggersOf(list).has("pull_request"), "the `on: [push, pull_request]` form must count");
  const quoted = parseWorkflow("'on':\n  pull_request:\n    types: [closed]\n");
  assert.equal(runsOnPrHead(triggersOf(quoted).get("pull_request")), false, "a quoted `on` key is still the trigger");
});

/** The step that checks the repository out, found by what it does (`uses:`), not by where a line sits. */
const CHECKOUT = STEPS.find((s) => /^actions\/checkout@/.test(String(s.step.uses ?? "")));

// ---------------------------------------------------------------------------------------------------------------
// C3 — BEHAVIOURAL. W171's extra mutation moved the identical `ref:` line onto `actions/setup-node`, where it is
// ignored, and the old file-wide regex stayed green. The ref must be inside the step that consumes it.
// ---------------------------------------------------------------------------------------------------------------

test("C3 the actions/checkout step pins the PR head SHA, inside that step", () => {
  assert.ok(CHECKOUT, "ci.yml has no actions/checkout step, so nothing pins the checked-out commit");
  const ref = String(CHECKOUT.step.with?.ref ?? "");
  assert.match(
    ref,
    /^\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}\s*$/,
    `actions/checkout's with.ref is "${ref}" (on ${CHECKOUT.jobName} step ${CHECKOUT.index}). Without the PR head SHA ` +
      "a pull_request workflow checks out a synthetic merge commit, and \"the CI conclusion for this head SHA is " +
      "success\" is a statement about a commit nobody pushed. A `ref:` on any other step does not do this.",
  );
});

// ---------------------------------------------------------------------------------------------------------------
// C4 — BEHAVIOURAL, spelling-independent. W171 §2 W3: `continue-on-error: ${{ matrix.soft }}` soft-failed a step and
// the old regex for the literal `true` stayed green. GitHub honours the key with any expression, with quoted strings
// and with YAML's own boolean spellings, so the rule is now about the KEY: it may only ever be written `false`.
// Every other value — `true`, `True`, `'true'`, `${{ … }}`, `matrix.soft` — can report success for a failure.
// ---------------------------------------------------------------------------------------------------------------

test("C4 nothing in ci.yml can report success for a failure: every continue-on-error is literally false", () => {
  const hits = continueOnErrorValues(CI_TEXT);
  for (const hit of hits) {
    assert.match(
      hit.value,
      /^false$/i,
      `ci.yml:${hit.line} sets continue-on-error to \"${hit.value}\" — any value but false lets a failed step report ` +
        "success, which is what this assertion forbids. GitHub honours the key with an expression (`${{ … }}`), a " +
        "quoted string and every YAML boolean spelling; requiring `false` covers all of them at once.",
    );
  }
  // The same rule read from the parse, so a spelling the line scan cannot see (a flow mapping) cannot hide.
  const nodes = [...STEPS.map((s) => s.step), ...Object.values(WORKFLOW.jobs ?? {})];
  for (const node of nodes) {
    for (const key of Object.keys(node ?? {})) {
      if (!/continue-on-error/i.test(key)) continue;
      assert.match(
        String(node[key]).trim().toLowerCase() || "<empty>",
        /^false$/,
        `a parsed node sets ${key} to \"${node[key]}\"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// C5 — BEHAVIOURAL. W171 §2 W4: `if: ${{ false }}` on the `Unit tests` step left every test green — the command was
// in the file and never ran. "The string appears" is not the property; "a step's own run: executes it, and nothing
// can skip that step" is. `with:` values and comments never reach step.run, so they cannot satisfy this.
// ---------------------------------------------------------------------------------------------------------------

/** The property both C5 and every per-clause row need: the unit tests are executed on the green path. */
function assertUnitTestsRun(preface) {
  const unit = stepNamed("Unit tests");
  assert.ok(unit, `${preface}ci.yml has no job step named "Unit tests"`);
  assert.ok(Object.hasOwn(WORKFLOW.jobs ?? {}, unit.jobName), `${preface}"Unit tests" is not a step of a job`);
  assert.equal(
    scriptOf(unit.step).trim(),
    "npm test",
    `${preface}the "Unit tests" step's run: must be \`npm test\` — a mention of it in a comment, a with: value or ` +
      "another step's script does not run the suite",
  );
  assert.equal(
    unit.step.if,
    undefined,
    `${preface}the "Unit tests" step has an if:, so it can be skipped while the file still names npm test`,
  );
  assert.equal(unit.step["continue-on-error"], undefined, `${preface}the "Unit tests" step may not fail soft`);
  assert.equal(
    WORKFLOW.jobs[unit.jobName].if,
    undefined,
    `${preface}the job "${unit.jobName}" has an if:, so its steps (including the unit tests) can be skipped`,
  );
  for (const rx of SHELL_SWALLOWS) {
    assert.doesNotMatch(
      scriptOf(unit.step),
      rx,
      `${preface}the "Unit tests" step swallows a non-zero exit (${rx}), so a failing suite reports success`,
    );
  }
  return unit;
}

test("C5 the `Unit tests` step executes `npm test`, and nothing can skip it", () => {
  assertUnitTestsRun("");
});

// ---------------------------------------------------------------------------------------------------------------
// C6–C12 — one row per clause. W171 §4 graded these: the exclusion check (b) and the `npm test` script check (c) are
// real properties that redden; (a) and (e) were word-matching, and the row never asserted the receipt exists.
// Now: (a) stays as the declared TEXT-ONLY name-shape check with a real property beside it (the config does not
// override `include:`), (e) is C2's parsed predicate, and existence is asserted first — W171 §2 W5 deleted a receipt
// and this row stayed green.
// ---------------------------------------------------------------------------------------------------------------

const PACKAGE = readFileSync(join(ROOT, "package.json"), "utf8");

for (const { ticket, clause, half, receipt } of CLAUSES) {
  test(`${ticket} ${clause} (${half}): CI green is only about this clause if npm test runs ${receipt}`, () => {
    // 1. The receipt is a file. Without this, deleting it left the row green (W171 §2 W5).
    assert.ok(
      existsSync(join(ROOT, receipt)),
      `${ticket}: ${receipt} does not exist, so a green CI says nothing about ${clause}`,
    );
    // 2. TEXT-ONLY: the name has the shape vitest's default include collects (a mirror of the library constant).
    assert.match(receipt, DEFAULT_INCLUDE, `${ticket}: ${receipt} is not a name vitest's default include matches`);
    // 3. PROPERTY beside it: the config keeps that default, so the mirrored pattern still describes collection.
    assert.doesNotMatch(
      DEFAULT_CONFIG,
      /^\s*include:/m,
      `${ticket}: vitest.config.mts overrides include:, so vitest's default pattern no longer decides what npm test collects`,
    );
    // 4. The other half's receipt is not excluded from the run CI green is about.
    assert.deepEqual(
      excludedBy(receipt),
      [],
      `${ticket}: ${receipt} is excluded from \`npm test\`, so CI green says nothing about ${clause}`,
    );
    // 5. `npm test` is that same default config (`vitest run`, no -c), so the exclusion list above is the one CI applies.
    assert.match(
      PACKAGE,
      /"test":\s*"vitest run"/,
      `${ticket}: \`npm test\` must be the default-config vitest run this check reasoned about`,
    );
    // 6. A step executes it, unconditionally (C5's property, repeated so a failure names this clause).
    assertUnitTestsRun(`${ticket}: `);
    // 7. The workflow runs on a PR head, so a conclusion exists for the branch head at all (C2's predicate).
    assert.ok(
      runsOnPrHead(TRIGGERS.get("pull_request")),
      `${ticket}: ci.yml does not run on a pull-request head, so no CI conclusion exists for the head of the branch ` +
        `that carries ${receipt}`,
    );
  });
}
