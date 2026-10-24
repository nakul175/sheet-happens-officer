// W184 — the release rules have ONE implementation, and this fails if a second appears.
//
// W160 made scripts/acceptance/release-identity.mjs the gate's only answer, but the tree still
// carried copies: the release-comparison rule lived twice (the module, and a `Math.min(...) >= 7`
// prefix test in scripts/w61-2689-accept.mjs) with no test comparing them, and the directory
// rule lived three times (the module, scripts/drain-burst.mjs, and a third read of
// `.next/BUILD_ID` inside the gate's build_release). Two answers to "is this the release" is
// exactly how W160's divergence happened, so the copies are gone and this keeps them gone.
//
// The guard is a GREP, the way scripts/ci/browser-tier-specs.test.mjs guards the browser tier:
// narrow, code-shaped signatures that no prose or GATE=FAIL message matches. Each signature has
// a POSITIVE CONTROL — the same grep run over a snippet that contains a copy must find it, so a
// guard that matches nothing can never pass.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { identityProblem, releaseMatches } from "./release-identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SCRIPTS = path.join(ROOT, "scripts");
const MODULE = path.join(SCRIPTS, "acceptance", "release-identity.mjs");

/** Every non-test .mjs/.sh under scripts/, which is where a copy could hide. */
function sources(dir = SCRIPTS, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sources(full, out);
      continue;
    }
    if (!/\.(mjs|sh)$/.test(entry.name) || /\.test\.mjs$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/**
 * The code-shaped signatures of each rule. `owner` is the one file allowed to contain it;
 * `null` means no file may. Tests are not scanned, and neither are comments that explain a rule:
 * the guard forbids a second IMPLEMENTATION, not a sentence about it.
 */
const RULES = [
  { rule: "release-comparison: the 7-character floor", pattern: /\.length\s*<\s*7\b/, owner: MODULE },
  { rule: "release-comparison: the prefix direction", pattern: /startsWith\((?:expected|observed|e|o)\)/, owner: MODULE },
  { rule: "release-comparison: the second copy's shape", pattern: /Math\.min\([^)]*length[^)]*\)\s*>=\s*7/, owner: null },
  { rule: "directory: reading the build id", pattern: /path\.join\([^)]*["']BUILD_ID["']/, owner: MODULE },
  { rule: "directory: reading .next/BUILD_ID from bash", pattern: /<[^>\n]*\.next\/BUILD_ID/, owner: null },
  { rule: "directory: the dev-server artifact test", pattern: /existsSync\([^)]*["']dev["']/, owner: MODULE },
  { rule: "directory: the entry must be a regular file", pattern: /statSync\(.*\)\.isFile\(\)/, owner: MODULE },
];

/** [{rule, file, line, text}] for every signature found outside its owner. */
function copiesIn(file, source) {
  const found = [];
  for (const { rule, pattern, owner } of RULES) {
    if (owner === file) continue;
    source.split("\n").forEach((text, i) => {
      if (pattern.test(text)) found.push({ rule, file: rel(file), line: i + 1, text: text.trim() });
    });
  }
  return found;
}

test("each rule is implemented exactly once, in release-identity.mjs", () => {
  const moduleSource = readFileSync(MODULE, "utf8");
  // The owner really holds the signature: a rule that matches nothing would make the scan below
  // vacuous, so every owned signature must be present in the module.
  for (const { rule, pattern, owner } of RULES) {
    if (owner !== MODULE) continue;
    assert.ok(pattern.test(moduleSource), `release-identity.mjs must implement "${rule}" (${pattern})`);
  }
  const found = sources().flatMap((file) => copiesIn(file, readFileSync(file, "utf8")));
  assert.deepEqual(
    found,
    [],
    `a second implementation of a release rule is in the tree:\n${found.map((f) => `  ${f.file}:${f.line} ${f.rule}\n    ${f.text}`).join("\n")}`,
  );
});

test("positive control: the same scan DOES find a copy when one is present", () => {
  // A copy of both rules, in the shape the deleted copies had. If the guard cannot see this, it
  // is guarding nothing.
  const copy = [
    "const expected = expectedSha.trim().toLowerCase();",
    "const observed = shaObserved.toLowerCase();",
    "const match = expected === observed || (Math.min(expected.length, observed.length) >= 7 && (observed.startsWith(expected) || observed.startsWith(observed)));",
    'buildId = fs.readFileSync(path.join(nextDir, "BUILD_ID"), "utf8").trim() || null;',
    'devArtifacts = fs.existsSync(path.join(nextDir, "dev"));',
    'if (!fs.statSync(path.join(APP_ROOT, ENTRY)).isFile()) throw new Error("not a release");',
    "printf 'BUILD=ok build-id=%s\\n' \"$(tr -d '[:space:]' <\"$app/.next/BUILD_ID\")\"",
  ].join("\n");
  const found = copiesIn(path.join(SCRIPTS, "a-second-copy.mjs"), copy);
  const rules = new Set(found.map((f) => f.rule));
  for (const needle of [
    "release-comparison: the second copy's shape",
    "release-comparison: the prefix direction",
    "directory: reading the build id",
    "directory: reading .next/BUILD_ID from bash",
    "directory: the dev-server artifact test",
    "directory: the entry must be a regular file",
  ]) {
    assert.ok(
      rules.has(needle),
      `the guard missed "${needle}" in a source that contains it:\n${found.map((f) => f.rule).join("\n")}`,
    );
  }
});

test("the gate and the other two runners ask the module instead of deciding themselves", () => {
  const gate = readFileSync(path.join(SCRIPTS, "acceptance", "linux-drain-gate.sh"), "utf8");
  assert.match(gate, /--match/, "the gate's release comparison is `node $IDENTITY --match`");
  assert.match(gate, /--build-id/, "the gate's build id is `node $IDENTITY --build-id`");
  assert.match(gate, /production_precondition\(\)[\s\S]*?node "\$IDENTITY"/, "the gate's directory rule asks the module");

  const burst = readFileSync(path.join(SCRIPTS, "drain-burst.mjs"), "utf8");
  assert.match(burst, /from "\.\/acceptance\/release-identity\.mjs"/, "the burst harness imports the module");
  assert.match(burst, /identityProblem\(/, "the burst harness asks the directory rule");

  const w61 = readFileSync(path.join(SCRIPTS, "w61-2689-accept.mjs"), "utf8");
  assert.match(w61, /from "\.\/acceptance\/release-identity\.mjs"/, "the W61 runner imports the module");
  assert.match(w61, /releaseMatches\(/, "the W61 runner asks the comparison rule");

  // …and the module still answers, so the delegations above are not delegating to nothing.
  assert.equal(releaseMatches("abcdef1", "abcdef1234567890"), true);
  assert.equal(releaseMatches("abcdef1", "abc"), false);
  assert.equal(identityProblem(path.join(ROOT, "no-such-release")), "missing-production-entry");
});

