// SHO-2689 — the gate's per-run conditions, driven from fixture documents.
//
// linux-drain-gate.sh decides c1-bad, c2-drain, c3-exit, c4-probe, c4-signal and c0-serving
// by string-comparing what read_burst() printed from drain-burst.mjs's JSON. Both halves are
// bash inside a run that needs a Linux kernel, so on darwin neither half can be reached and
// an edit to either one answers a different question while every test stays green.
//
// This file sources the real read_burst() (no sockets, no server, no build) and feeds it
// fixture documents, then pins the strings it emits to the literals the gate compares
// against. That is the seam: if read_burst's vocabulary or a comparator changes, the two no
// longer meet and this file fails.
//
// It is NOT Linux acceptance. It asserts what the gate CONCLUDES from a report of a drain;
// it never produces one.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ENTRY, releaseMatches } from "./release-identity.mjs";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const source = readFileSync(script, "utf8");

function bash(body, args = [], input) {
  return spawnSync("bash", ["-c", `source "$1"; shift; ${body}`, "--", script, ...args], {
    encoding: "utf8",
    input,
  });
}

/** read_burst's output for one document, as its printed lines. */
function lines(doc) {
  const out = bash("read_burst", [], typeof doc === "string" ? doc : JSON.stringify(doc));
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trimEnd().split("\n");
}

function field(printed, name) {
  const line = printed.find((l) => l.startsWith(`${name}=`));
  assert.ok(line, `read_burst printed no ${name}= line (got ${JSON.stringify(printed)})`);
  return line;
}

/** A document from a run that satisfied the protocol: the shape a PASS needs. */
const CLEAN = {
  n: 100,
  inFlight: { statuses: { "200": 100 }, non200: 0 },
  drainedLine: "logged",
  exit: { code: 0 },
  afterSigterm: { late16: "refused", late143: "refused" },
  shutdownLines: ["graceful shutdown: drained in-flight requests"],
  serving: { entry: "server.js", nodeEnv: "production", buildId: "present", devArtifacts: false },
  release: "94cf6d9593e815a8492e2a0e64bbf11fce29c905",
  sigtermDelayMs: 40,
};

/** The literal the gate compares `$<name>` against, with its one shell variable expanded. */
function compared(name) {
  const m = source.match(new RegExp(`\\[ "\\$${name}" != "([^"]+)" \\]`));
  assert.ok(m, `the gate no longer compares $${name}; this fixture set has to be re-read`);
  return m[1].replace("$ENTRY", ENTRY);
}

// The conditions run_bursts() compares, in gate order: the shell's variable name and the
// RUN-line field it read that variable from. They differ for c3-exit (`$ecode` <- `exit=0`).
const COMPARED = [
  { shellVar: "bad", field: "bad" },
  { shellVar: "drain", field: "drain" },
  { shellVar: "ecode", field: "exit" },
  { shellVar: "late16", field: "late16" },
  { shellVar: "late143", field: "late143" },
  { shellVar: "sigterm", field: "sigterm" },
  { shellVar: "serving", field: "serving" },
];
const DECISION_FIELD = {
  "c1-bad": "bad",
  "c2-drain": "drain",
  "c3-exit": "exit",
  "c4-signal": "sigterm",
  "c4-probe": "late16",
  "c0-serving": "serving",
};

test("a clean production burst satisfies every string the gate compares", () => {
  const printed = lines(CLEAN);
  for (const { shellVar, field: name } of COMPARED) {
    assert.equal(field(printed, name), compared(shellVar), shellVar);
  }
});

// ---------------------------------------------------------------- the five mutations
//
// Each row breaks ONE input in a copy of CLEAN and asserts the flip both ways: the clean
// document does not print the failing token, the broken one does, and exactly one gated
// condition changed. A fixture set that cannot fail is decoration.
const MUTATIONS = [
  {
    decision: "c1-bad",
    breaks: "one dropped request (200 -> 99, non200 -> 1)",
    apply: (d) => {
      d.inFlight = { statuses: { "200": 99, reset: 1 }, non200: 1 };
    },
    failing: "bad=[200:99 reset:1]",
  },
  {
    decision: "c2-drain",
    breaks: "the clean-drain line was not printed",
    apply: (d) => {
      d.drainedLine = "absent";
      d.shutdownLines = ["graceful shutdown: drain timed out"];
    },
    failing: "drain=absent",
  },
  {
    decision: "c3-exit",
    breaks: "the server exited 1 instead of 0",
    apply: (d) => {
      d.exit = { code: 1 };
    },
    failing: "exit=1",
  },
  {
    decision: "c4-signal",
    breaks: "SIGTERM landed at 37 ms, not 40",
    apply: (d) => {
      d.sigtermDelayMs = 37;
    },
    failing: "sigterm=37",
  },
  {
    decision: "c0-serving",
    breaks: "a dev server's artifacts were mixed into the release",
    apply: (d) => {
      d.serving = { ...d.serving, devArtifacts: true };
    },
    failing: "serving=entry:server.js nodeEnv:production build:present dev:yes",
  },
  {
    decision: "c4-probe",
    breaks: "the +16 ms probe was accepted instead of refused",
    apply: (d) => {
      d.afterSigterm = { late16: "open", late143: "refused" };
    },
    failing: "late16=open",
  },
];

test("each broken fixture fails its own decision and only that one", () => {
  const clean = lines(CLEAN);
  for (const row of MUTATIONS) {
    const broken = structuredClone(CLEAN);
    row.apply(broken);
    const brokenLines = lines(broken);

    assert.ok(
      !clean.includes(row.failing),
      `${row.decision}: the clean fixture already prints ${row.failing}`,
    );
    assert.ok(
      brokenLines.includes(row.failing),
      `${row.decision}: the broken fixture did not print ${row.failing} (got ${JSON.stringify(field(brokenLines, DECISION_FIELD[row.decision]))})`,
    );

    const changed = COMPARED.map((c) => c.field).filter(
      (f) => field(brokenLines, f) !== field(clean, f),
    );
    assert.deepEqual(changed, [DECISION_FIELD[row.decision]], `${row.decision}: ${row.breaks}`);
  }
});

test("a wrong N is reported as a dropped request: the shell has no N condition of its own", () => {
  // read_burst hardcodes the protocol's 100 (`statuses["200"] === 100`), so a burst of 99
  // that answered all 99 reads as a dropped socket, not as a short burst. drain-verdict.mjs's
  // nVerdict names that `n`; this tree has neither the function nor the GATE=FAIL line.
  const short = structuredClone(CLEAN);
  short.n = 99;
  short.inFlight = { statuses: { "200": 99 }, non200: 0 };
  assert.equal(field(lines(short), "bad"), "bad=[200:99]");
  assert.ok(!/GATE=FAIL n\b/.test(source), "a standalone N reason appeared: move this row to it");
});

// ---------------------------------------------------------------- the release match (D5)
//
// c0-release is the one decision here with a real extracted implementation:
// release-identity.mjs:releaseMatches(), asked through `--match` by c0_release_ok(). Pin the
// two to the same answer for every pair, so a gate and its off-Linux evidence cannot drift.
test("releaseMatches and the gate's c0_release_ok answer identically on every pair", () => {
  const sha = CLEAN.release;
  const pairs = [
    [sha, sha],
    [sha.slice(0, 7), sha],
    [sha, sha.slice(0, 7)],
    [sha.slice(0, 6), sha],
    [sha.toUpperCase(), sha],
    [sha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
    [sha, ""],
    ["", sha],
    ["none", "none"],
  ];
  for (const [expected, observed] of pairs) {
    const predicate = bash('c0_release_ok "$@"', [expected, `release=${observed}`]);
    assert.equal(
      predicate.status === 0,
      releaseMatches(expected, observed),
      `expected=${expected} release=${observed}: shell said ${predicate.status}, module disagreed`,
    );
  }
});

// ---------------------------------------------------------------- failure-mode coverage
//
// Every `GATE=FAIL cX-*` the shell can emit must have a fixture (or a named predicate) that
// reaches it. The list is parsed out of the script, so a NEW condition with no fixture row
// fails this test instead of shipping uncovered.
const COVERED_BY_FIXTURE = new Set(["c1-bad", "c2-drain", "c3-exit", "c4-probe", "c4-signal", "c0-serving"]);
const COVERED_BY_PREDICATE = new Set(["c0-release"]);

test("every cX-* failure mode the shell can emit is covered", () => {
  const emitted = [...source.matchAll(/printf 'GATE=FAIL (c\d-[a-z]+) run=/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 7, `parsed only ${emitted.length} cX-* emitters out of the gate`);
  const uncovered = emitted.filter(
    (r) => !COVERED_BY_FIXTURE.has(r) && !COVERED_BY_PREDICATE.has(r),
  );
  assert.deepEqual(uncovered, [], `no fixture or predicate covers: ${uncovered.join(", ")}`);
});

test("the fixture path never claims to be acceptance: it starts nothing", () => {
  // The gate refuses on this kernel before any socket; this file does not work around that.
  const refusal = spawnSync("bash", [script, "deadbeef"], { encoding: "utf8" });
  assert.equal(refusal.status, 3);
  assert.match(refusal.stdout, /^GATE=REFUSED reason=not-linux$/m);
  assert.doesNotMatch(refusal.stdout, /^GATE=PASS/m);
});
