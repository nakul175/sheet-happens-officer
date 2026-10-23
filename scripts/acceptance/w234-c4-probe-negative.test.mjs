// SHO-2689 / W234 — the two halves of c4-probe are two decisions, and the tier produced only one
// of them.
//
// linux-drain-gate.sh:638 decides c4-probe for BOTH post-SIGTERM probes in ONE condition:
//
//   if [ "$late16" != "late16=refused" ] || [ "$late143" != "late143=refused" ]; then
//
// Two facts about the acceptance tier as of 5b84407, both measured before this file was written:
//
//   1. `late143` occurs in the whole suite only as `refused`. drain-conditions-fixtures.test.mjs
//      mutates c4-probe by breaking `late16` ALONE (its line 146), so nothing had ever shown
//      read_burst turning an ACCEPTED +143 ms probe into `late143=open` — the mapping the second
//      half of the rule rests on.
//   2. run_bursts() is driven end to end by exactly one test, the c0-release stub at
//      linux-drain-gate.test.mjs:371-427. Every other cX decision is pinned only as
//      "read_burst's word for it equals the gate's literal", which is a vocabulary pin, not a run.
//
// Consequence, and why this file exists: the `||` can be rewritten to `&&` and a burst whose
// +16 ms probe was refused while its +143 ms probe was ACCEPTED still returns 0 — a server that
// kept accepting connections after SIGTERM would be reported GATE=PASS. The fixture file stays
// green under that edit because it never calls run_bursts. So this drives the gate's own loop
// with a stub document, the way the c0-release case does, once per half plus a control.
//
// This is not Linux acceptance: the stub answers for the harness, so it proves what the gate
// CONCLUDES from a report of a drain, never that the drain happened.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const SHA = "abcdef1234567890";

/** The shape a PASS needs, with the two post-SIGTERM probes chosen by the caller. */
function document(late16, late143) {
  return {
    n: 100,
    sigtermDelayMs: 40,
    inFlight: { requested: 100, non200: 0, statuses: { 200: 100 } },
    afterSigterm: { late16, late143 },
    exit: { code: 0, signal: null },
    drainedLine: "logged",
    shutdownLines: ["graceful shutdown: drained in-flight requests"],
    serving: { entry: "server.js", nodeEnv: "production", buildId: "present", devArtifacts: false },
    release: SHA,
  };
}

/**
 * One production burst through the gate's own run_bursts(), with a stub harness that answers
 * from a JSON file. No socket, no build, no server: the document is the whole input.
 */
function burstWith(documentObject, work) {
  const docPath = path.join(work, "doc.json");
  const stub = path.join(work, "stub-burst.mjs");
  const app = path.join(work, "app");
  writeFileSync(docPath, JSON.stringify(documentObject));
  writeFileSync(
    stub,
    `import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(process.env.STUB_DOC, "utf8"));
doc.release = process.env.RELEASE ?? null;
process.stdout.write(JSON.stringify(doc) + "\\n");
`,
  );
  mkdirSync(path.join(app, ".next"), { recursive: true });
  writeFileSync(path.join(app, "server.js"), "// entry\n");
  writeFileSync(path.join(app, ".next", "BUILD_ID"), "sRxBtLUUZRc5LUDXn1GTm\n");

  const out = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; BURST="$2"; TMP="$3"; GATE_RUNS=1; GATE_N=100; run_bursts production "$4" "$5"; printf "RC=%s\\\\n" "$?"',
      "--",
      script,
      stub,
      work,
      SHA,
      app,
    ],
    { encoding: "utf8", env: { ...process.env, STUB_DOC: docPath } },
  );
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

/** Which cX-* conditions the loop reported, so "it failed" can be read precisely. */
function failures(stdout) {
  return [...stdout.matchAll(/^GATE=FAIL (c\d-[a-z]+) run=/gm)].map((m) => m[1]);
}


test("an ACCEPTED +16 ms probe fails c4-probe on its own, through run_bursts", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-w234-late16-"));
  try {
    const got = burstWith(document("open", "refused"), work);
    // The run line maps the report's word for it, so the decision is comparable at all.
    assert.match(
      got.stdout,
      /^RUN 1\/1 mode=production n=100 bad=\[\] drain=drained exit=0 late16=open late143=refused /m,
      got.stdout,
    );
    assert.match(got.stdout, /^GATE=FAIL c4-probe run=1 late16=open late143=refused$/m, got.stdout);
    assert.deepEqual(failures(got.stdout), ["c4-probe"], "only the probe condition may fire");
    assert.match(got.stdout, /^RC=1$/m, "run_bursts reports evidence that did not hold");
    assert.ok(!got.stdout.includes("GATE=PASS"), "a probe accepted after SIGTERM must never pass");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// The half no fixture produced: a +143 ms probe accepted while the +16 ms one was refused.
// Under a `&&` rewrite of line 638 this run returns 0 and the burst reads as clean.
test("an ACCEPTED +143 ms probe alone fails c4-probe, through run_bursts", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-w234-late143-"));
  try {
    const got = burstWith(document("refused", "open"), work);
    assert.match(
      got.stdout,
      /^RUN 1\/1 mode=production n=100 bad=\[\] drain=drained exit=0 late16=refused late143=open /m,
      got.stdout,
    );
    assert.match(got.stdout, /^GATE=FAIL c4-probe run=1 late16=refused late143=open$/m, got.stdout);
    assert.deepEqual(failures(got.stdout), ["c4-probe"], "only the probe condition may fire");
    assert.match(got.stdout, /^RC=1$/m, got.stdout);
    assert.ok(!got.stdout.includes("GATE=PASS"), "a probe accepted 143 ms after SIGTERM must never pass");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("control: both probes refused passes c4-probe, so the two cases above are about the probe", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-w234-late-ok-"));
  try {
    const got = burstWith(document("refused", "refused"), work);
    assert.deepEqual(failures(got.stdout), [], `nothing may fail on a clean document:\n${got.stdout}`);
    assert.match(got.stdout, /^RC=0$/m, "every condition of the run held");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------- totality across the runs
//
// run_bursts() is a LOOP (`for ((run = 1; run <= GATE_RUNS; run += 1))`) whose `ok` must stay
// false once any single run has failed — a gate that reported the LAST run only, or that reset
// `ok` per iteration, would pass a receipt with a broken run 2 of 5 inside it. Every existing
// driver of the loop uses GATE_RUNS=1 (linux-drain-gate.test.mjs:376, and the cases above), so
// the accumulation itself had no negative case. These two drive three runs.
function burstSequence(documentObjects, work) {
  const docsPath = path.join(work, "docs.json");
  const counterPath = path.join(work, "call-count");
  const stub = path.join(work, "stub-sequence.mjs");
  const app = path.join(work, "app");
  writeFileSync(docsPath, JSON.stringify(documentObjects));
  writeFileSync(counterPath, "0");
  writeFileSync(
    stub,
    `import { readFileSync, writeFileSync } from "node:fs";
const docs = JSON.parse(readFileSync(process.env.STUB_DOCS, "utf8"));
const counter = process.env.STUB_COUNT;
const i = Number(readFileSync(counter, "utf8"));
writeFileSync(counter, String(i + 1));
const doc = structuredClone(docs[Math.min(i, docs.length - 1)]);
doc.release = process.env.RELEASE ?? null;
process.stdout.write(JSON.stringify(doc) + "\\n");
`,
  );
  mkdirSync(path.join(app, ".next"), { recursive: true });
  writeFileSync(path.join(app, "server.js"), "// entry\n");
  writeFileSync(path.join(app, ".next", "BUILD_ID"), "sRxBtLUUZRc5LUDXn1GTm\n");

  const out = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; BURST="$2"; TMP="$3"; GATE_RUNS=3; GATE_N=100; run_bursts production "$4" "$5"; printf "RC=%s\\n" "$?"',
      "--",
      script,
      stub,
      work,
      SHA,
      app,
    ],
    { encoding: "utf8", env: { ...process.env, STUB_DOCS: docsPath, STUB_COUNT: counterPath } },
  );
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

test("one broken run of three fails the gate, and the failing run is named by index", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-w234-totality-"));
  try {
    const broken = document("refused", "refused");
    broken.exit = { code: 1, signal: null };
    const got = burstSequence([document("refused", "refused"), broken, document("refused", "refused")], work);
    assert.equal(got.stdout.match(/^RUN \d\/3 /gm)?.length, 3, `three runs must be measured:\n${got.stdout}`);
    assert.match(got.stdout, /^GATE=FAIL c3-exit run=2 exit=1$/m, got.stdout);
    assert.ok(!/^GATE=FAIL c3-exit run=[13]\b/m.test(got.stdout), "the clean runs must stay clean");
    assert.deepEqual(failures(got.stdout), ["c3-exit"], "exactly one condition, once");
    assert.match(got.stdout, /^RC=1$/m, "a failure anywhere in the loop is a failed run_bursts");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("control: three clean runs measure three times and report nothing", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-w234-totality-ok-"));
  try {
    const clean = () => document("refused", "refused");
    const got = burstSequence([clean(), clean(), clean()], work);
    assert.equal(got.stdout.match(/^RUN \d\/3 /gm)?.length, 3, `three runs must be measured:\n${got.stdout}`);
    assert.deepEqual(failures(got.stdout), [], `nothing may fail on clean documents:\n${got.stdout}`);
    assert.match(got.stdout, /^RC=0$/m, got.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
