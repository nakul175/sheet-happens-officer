// SHO-2689 — the Linux drain gate must be INCAPABLE of a green that is not deployed
// acceptance.
//
// Three things are pinned here, all on a darwin host where the gate refuses before it can
// do any of them:
//
//   1. the KERNEL refusal: a non-Linux kernel cannot return PASS whatever the evidence says;
//   2. the MODE refusal: `--dev` cannot reach GATE=PASS either — exactly one statement in
//      the file prints GATE=PASS, it lives in production_run(), and gate_verdict() returns
//      NOT-ACCEPTANCE for any mode that is not production before PASS is reachable;
//   3. the PRODUCTION PRECONDITION: a directory without `.next/BUILD_ID`, without the entry,
//      or carrying a dev server's artifacts, fails before a socket is opened.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ENTRY, releaseMatches } from "./release-identity.mjs";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const source = readFileSync(script, "utf8");

function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Run one of the script's functions in a clean shell: no sockets, no files, just the answer.
function call(body, args = []) {
  const out = spawnSync("bash", ["-c", `source "$1"; shift; ${body}`, "--", script, ...args], {
    encoding: "utf8",
  });
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

function verdict(kernel, mode, evidenceOk) {
  const out = call(`gate_verdict "$@"`, [kernel, mode, evidenceOk]);
  return { verdict: out.stdout.trim(), status: out.status };
}

// ---------------------------------------------------------------- 1. the kernel refusal

test("a non-Linux kernel cannot return PASS even when every condition is satisfied", () => {
  for (const kernel of ["Darwin", "FreeBSD", "MINGW64_NT-10.0", "SunOS", "unknown", ""]) {
    for (const mode of ["production", "dev"]) {
      const got = verdict(kernel, mode, "true");
      assert.equal(got.verdict, "REFUSED", `kernel ${JSON.stringify(kernel)} mode ${mode}`);
      assert.equal(got.status, 3, `kernel ${JSON.stringify(kernel)} mode ${mode} exit code`);
      assert.ok(!got.verdict.includes("PASS"), `${kernel}/${mode} must not print PASS`);
    }
  }
});

// ---------------------------------------------------------------- 2. the mode refusal

test("the verdict is not vacuous: Linux passes only in production mode on satisfied evidence", () => {
  assert.deepEqual(verdict("Linux", "production", "true"), { verdict: "PASS", status: 0 });
  assert.deepEqual(verdict("Linux", "production", "false"), { verdict: "FAIL", status: 1 });
});

test("--dev cannot reach PASS: all evidence true, Linux, and it still is NOT-ACCEPTANCE", () => {
  for (const evidence of ["true", "false"]) {
    const got = verdict("Linux", "dev", evidence);
    assert.equal(got.verdict, "NOT-ACCEPTANCE", `dev with evidence ${evidence}`);
    assert.equal(got.status, 4, `dev exit code with evidence ${evidence}`);
    assert.ok(!got.verdict.includes("PASS"), "dev must never print PASS");
  }
  // And the unknown-mode arm is not a way around it either.
  assert.equal(verdict("Linux", "", "true").verdict, "NOT-ACCEPTANCE");
  assert.equal(verdict("Linux", "DEV", "true").verdict, "NOT-ACCEPTANCE");
});

function functionBody(name, nextName) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start > 0, `${name} must exist as its own function`);
  const end = source.indexOf(`${nextName}() {`, start);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("exactly one place prints GATE=PASS, and it is inside the production branch", () => {
  assert.equal(source.split("printf 'GATE=PASS").length - 1, 1, "exactly one GATE=PASS statement");

  // It is inside production_run(), and nowhere else in the file.
  const production = functionBody("production_run", "dev_run");
  const site = source.indexOf("printf 'GATE=PASS");
  const start = source.indexOf("production_run() {");
  assert.ok(production.includes("printf 'GATE=PASS"), "GATE=PASS lives in production_run()");
  assert.ok(site > start && site < source.indexOf("dev_run() {"), "the only GATE=PASS is inside production_run()");
  assert.equal(source.indexOf("printf 'GATE=PASS", start), site, "there is no second emitter after this one");

  // dev_run() prints the NOT-ACCEPTANCE line and cannot print PASS.
  const dev = functionBody("dev_run", "main");
  assert.ok(dev.includes("printf 'GATE=NOT-ACCEPTANCE mode=dev\\n'"), "dev_run prints the NOT-ACCEPTANCE line");
  assert.ok(!dev.includes("GATE=PASS"), "dev_run must contain no GATE=PASS");
  assert.ok(!dev.includes("printf 'PASS'"), "dev_run must not print the bare verdict PASS");

  // production_run() is only reachable from the production arm of main()'s dispatch.
  const main = source.slice(source.indexOf("main() {"));
  assert.ok(/production\)\n\s+production_run "\$sha"/.test(main), "main dispatches production) -> production_run");
  assert.ok(/dev\)\n\s+dev_run "\$sha"/.test(main), "main dispatches dev) -> dev_run");
});

test("inside gate_verdict the kernel branch precedes the mode branch, which precedes PASS", () => {
  const fn = functionBody("gate_verdict", "harness_pin");
  const kernelBranch = fn.indexOf('if [ "$kernel" != "Linux" ]; then');
  const modeBranch = fn.indexOf('if [ "$mode" != "production" ]; then');
  const passEmitter = fn.indexOf("printf 'PASS'");
  assert.ok(kernelBranch > 0, "gate_verdict branches on the kernel");
  assert.ok(modeBranch > kernelBranch, "the mode branch sits below the kernel branch");
  assert.ok(passEmitter > modeBranch, "PASS sits below the mode branch");
  assert.ok(fn.slice(kernelBranch, modeBranch).includes("return 3"), "the kernel branch returns REFUSED");
  assert.ok(fn.slice(modeBranch, passEmitter).includes("return 4"), "the mode branch returns NOT-ACCEPTANCE");
});


// ---------------------------------------------------------------- 3. the refusal precedes everything
//
// On this host every mode is refused by the kernel first. On Linux these cases would be a
// usage error / a real run, so they are skipped there; the ORDER is proved structurally
// below, which is the part that must hold on both.
const isLinux = process.platform === "linux";
const refusalSkip = isLinux ? "Linux host: the refusal path is not the one under test" : false;

for (const args of [[], ["deadbeef"], ["--production", "deadbeef"], ["--dev", "deadbeef"], ["--dev"]]) {
  test(`on this host the real script refuses ${JSON.stringify(args)} with exit 3, before any mode`, { skip: refusalSkip }, () => {
    const out = run(args);
    assert.equal(out.status, 3, `exit code\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
    assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/, "first line verbatim");
    assert.ok(!/^RUN \d/m.test(out.stdout), "no burst may run");
    assert.ok(!/GATE=PASS/.test(out.stdout), "no pass line");
    assert.ok(!/GATE=NOT-ACCEPTANCE/.test(out.stdout), "no mode verdict either: the kernel wins");
    assert.ok(!/RELEASE=/.test(out.stdout), "the release line is only printed on Linux");
    assert.ok(!/^BUILD=/m.test(out.stdout), "no build is attempted");
  });
}

test("the kernel branch precedes the mode branch, the build and the burst in the run path", () => {
  const main = source.slice(source.indexOf("main() {"));
  const kernel = main.indexOf('if [ "$kernel" != "Linux" ]; then');
  assert.ok(kernel > 0, "main checks the kernel");
  for (const later of [
    'printf \'GATE=MODE mode=%s\\n\' "$mode"',
    "production_run \"$sha\"",
    "dev_run \"$sha\"",
    "prepare_build_root \"$ROOT\"",
    "harness_pin \"$BURST\"",
  ]) {
    const at = main.indexOf(later);
    assert.ok(at < 0 || at > kernel, `${later} must sit below the kernel refusal`);
  }
});

test("--explain prints both modes and their verbatim lines, with no side effects", () => {
  const out = run(["--explain"]);
  assert.equal(out.status, 0, out.stderr);
  for (const needle of [
    "c0-serving",
    "c0-release",
    "c1-bad",
    "c2-drain",
    "c3-exit",
    "c4-probe",
    "bad=[]",
    "graceful shutdown: drained in-flight requests",
    "graceful shutdown: drain timed out",
    "late16=refused late143=refused",
    "serving=entry:server.js nodeEnv:production build:yes dev:none",
    "GATE=PASS runs=5 n=100 release=<sha-under-test> entry=server.js",
    "GATE=NOT-ACCEPTANCE mode=dev",
    "GATE=REFUSED reason=not-linux",
    "--production (default) is the only mode that can print GATE=PASS",
    "N=100",
    "SIGTERM 40 ms",
    "next build",
  ]) {
    assert.ok(out.stdout.includes(needle), `--explain must mention ${needle}`);
  }
  assert.ok(!/^RUN \d/m.test(out.stdout), "no burst");
  assert.ok(!out.stdout.includes(process.env.DATABASE_URL ?? "\u0000"), "never prints the database url");
});


// ---------------------------------------------------------------- 4. the production precondition
//
// This is what makes the word "production" a fact rather than a label. Each case is built in
// a throwaway directory, so the assertions do not depend on this checkout having a build.
function precondition(dir) {
  const out = call(`production_precondition "$@"`, [dir]);
  return { stdout: out.stdout.trim(), status: out.status };
}

test("a missing BUILD_ID fails the production precondition, before any socket", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-nobuild-"));
  try {
    writeFileSync(path.join(dir, "server.js"), "// entry\n");
    const got = precondition(dir);
    assert.equal(got.status, 1, got.stdout);
    assert.match(got.stdout, /^GATE=FAIL missing-build-id \(/, "names the missing build");
    assert.ok(!got.stdout.includes("PRECONDITION=production"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty BUILD_ID is not a build", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-emptybuild-"));
  try {
    writeFileSync(path.join(dir, "server.js"), "// entry\n");
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "  \n");
    const got = precondition(dir);
    assert.equal(got.status, 1, got.stdout);
    assert.match(got.stdout, /^GATE=FAIL missing-build-id \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory with no production entry fails the precondition", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-noentry-"));
  try {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "build-1\n");
    const got = precondition(dir);
    assert.equal(got.status, 1, got.stdout);
    assert.match(got.stdout, /^GATE=FAIL missing-production-entry \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dev server's artifacts disqualify the directory even with a BUILD_ID", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-devdir-"));
  try {
    writeFileSync(path.join(dir, "server.js"), "// entry\n");
    mkdirSync(path.join(dir, ".next", "dev"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "build-1\n");
    const got = precondition(dir);
    assert.equal(got.status, 1, got.stdout);
    assert.match(got.stdout, /^GATE=FAIL dev-artifacts-present \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real build and the shipped entry pass the precondition", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-ok-"));
  try {
    writeFileSync(path.join(dir, "server.js"), "// entry\n");
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "build-1\n");
    const got = precondition(dir);
    assert.equal(got.status, 0, got.stdout);
    assert.equal(got.stdout, "PRECONDITION=production build-id=build-1 entry=server.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The harness makes the same refusal itself, so even a direct call cannot measure a dev
// server while claiming production. No socket is opened: the refusal is before the spawn.
test("drain-burst --production refuses a directory without a build, before spawning", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-burst-nobuild-"));
  try {
    const out = spawnSync(process.execPath, [path.join(path.dirname(script), "..", "drain-burst.mjs"), "1", "0", "--production"], {
      cwd: path.join(path.dirname(script), "..", ".."),
      encoding: "utf8",
      env: { ...process.env, SHO_APP_ROOT: dir, RELEASE: "deadbeef" },
      timeout: 20000,
    });
    assert.notEqual(out.status, 0, "must fail");
    assert.match(out.stderr, /BUILD_ID is missing/, `stderr:\n${out.stderr}`);
    assert.equal(out.stdout, "", "nothing was measured, so nothing was printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------- 5. the release identity
//
// c0-release compares the identity the serving process echoes (/api/health ->
// process.env.RELEASE, src/app/api/health/route.ts:10) with the RELEASE it was given.
function matches(expected, observed) {
  return call(`release_matches "$@"`, [expected, observed]).status;
}

test("release_matches accepts the same release, full or abbreviated", () => {
  assert.equal(matches("abcdef1234567890", "abcdef1234567890"), 0);
  assert.equal(matches("abcdef1", "abcdef1234567890"), 0, "full sha observed, abbreviated expected");
  assert.equal(matches("ABCDEF1234567890", "abcdef1234567890"), 0, "case-insensitive");
});

test("release_matches refuses a different release, an absent one, or a too-short prefix", () => {
  assert.equal(matches("abcdef1234567890", "abcdef1234567891"), 1, "different sha");
  assert.equal(matches("abcdef1234567890", "none"), 1, "no release echoed");
  assert.equal(matches("abcdef1234567890", ""), 1, "empty echo");
  assert.equal(matches("abcdef1", "abc"), 1, "an abbreviation under 7 characters is not unambiguous");
});

// The gate's release_matches is now a call into the module, so the anti-drift pin is that the
// two answer identically on the pairs that decide c0-release — including the ones where a copy
// would most plausibly drift (case, direction of the prefix, the 7-character floor, empty).
test("the gate's comparison is the module's comparison, pair for pair", () => {
  const pairs = [
    ["abcdef1234567890", "abcdef1234567890"],
    ["abcdef1", "abcdef1234567890"],
    ["abcdef1234567890", "abcdef1"],
    ["ABCDEF1234567890", "abcdef1234567890"],
    ["abcdef1234567890", "abcdef1234567891"],
    ["abcdef1", "abc"],
    ["abcdef1234567890", "none"],
    ["abcdef1234567890", ""],
    ["", "abcdef1234567890"],
    ["", ""],
    ["d08e66abe2eb", null],
  ];
  for (const [expected, observed] of pairs) {
    const shell = matches(expected ?? "", observed ?? "");
    const moduleResult = releaseMatches(expected, observed) ? 0 : 1;
    assert.equal(shell, moduleResult, `gate and module disagree on ${JSON.stringify([expected, observed])}`);
  }
});

// The one place a release comparison could still hide: the gate's ENTRY constant. The module
// is the single source, so the shell's copy must be the same string.
test("the gate's ENTRY is the module's ENTRY", () => {
  const shellEntry = /^ENTRY='([^']+)'$/m.exec(source)?.[1];
  assert.ok(shellEntry, "the gate declares ENTRY");
  assert.equal(shellEntry, ENTRY, "the gate and the module must name the same production entry");
});

// ---------------------------------------------------------------- 5b. a DIFFERENT release
//
// The packet's missing case: the tree under test IS a built release, the burst is clean, and
// /api/health echoes some OTHER release. Nothing but c0-release can catch it, so this drives
// run_bursts with a stub harness that returns such a document — otherwise the branch is only
// reachable inside a real Linux run, which is exactly how a gate's one identity condition goes
// untested. The control run uses the same document with the release under test in it.
const RELEASE_UNDER_TEST = "abcdef1234567890";

function stubBurst(dir) {
  const file = path.join(dir, "stub-burst.mjs");
  writeFileSync(
    file,
    `process.stdout.write(JSON.stringify({
  n: 100,
  sigtermDelayMs: 40,
  inFlight: { requested: 100, non200: 0, statuses: { 200: 100 } },
  afterSigterm: { late16: "refused", late143: "refused" },
  exit: { code: 0, signal: null },
  drainedLine: "logged",
  shutdownLines: ["graceful shutdown: drained in-flight requests"],
  serving: { entry: "server.js", nodeEnv: "production", buildId: "present", devArtifacts: false },
  release: process.env.STUB_RELEASE ?? null,
}) + "\\n");
`,
  );
  return file;
}

// One production burst against a stub harness, through the gate's own loop.
function burstWith(release, app, workDir) {
  const out = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; BURST="$2"; TMP="$3"; GATE_RUNS=1; run_bursts production "$4" "$5"; printf "RC=%s\\n" "$?"',
      "--",
      script,
      stubBurst(workDir),
      workDir,
      RELEASE_UNDER_TEST,
      app,
    ],
    { encoding: "utf8", env: { ...process.env, STUB_RELEASE: release } },
  );
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

function builtReleaseDir(dir) {
  mkdirSync(path.join(dir, ".next"), { recursive: true });
  writeFileSync(path.join(dir, "server.js"), "// entry\n");
  writeFileSync(path.join(dir, ".next", "BUILD_ID"), "sRxBtLUUZRc5LUDXn1GTm\n");
  return dir;
}

test("a built release that reports a DIFFERENT release fails c0-release and cannot PASS", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-gate-c0-release-"));
  try {
    const app = builtReleaseDir(path.join(work, "app"));
    const got = burstWith("deadbeefdeadbeef", app, work);
    assert.match(
      got.stdout,
      new RegExp(`^GATE=FAIL c0-release run=1 release=deadbeefdeadbeef expected=${RELEASE_UNDER_TEST}$`, "m"),
      got.stdout,
    );
    assert.match(got.stdout, /^RC=1$/m, "run_bursts reports evidence that did not hold");
    assert.ok(!got.stdout.includes("GATE=PASS"), "a differing release must never pass");

    // …and that evidence is what gate_verdict() turns into the verdict: FAIL, never PASS.
    assert.deepEqual(verdict("Linux", "production", "false"), { verdict: "FAIL", status: 1 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the same built release reporting ITSELF passes c0-release, so the case above is not vacuous", () => {
  const work = mkdtempSync(path.join(tmpdir(), "sho-gate-c0-release-ok-"));
  try {
    const app = builtReleaseDir(path.join(work, "app"));
    const got = burstWith(RELEASE_UNDER_TEST, app, work);
    assert.ok(!got.stdout.includes("GATE=FAIL c0-release"), got.stdout);
    assert.match(got.stdout, /^RC=0$/m, "every condition of the run held");
    assert.ok(!got.stdout.includes("GATE=PASS"), "run_bursts never prints the verdict, production_run does");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("read_burst maps a clean production burst to every satisfied condition", () => {
  const out = spawnSync("bash", ["-c", `source "$1"; read_burst`, "--", script], {
    encoding: "utf8",
    input: JSON.stringify({
      n: 100,
      sigtermDelayMs: 40,
      inFlight: { requested: 100, non200: 0, statuses: { 200: 100 } },
      afterSigterm: { late16: "refused", late143: "refused" },
      exit: { code: 0, signal: null },
      drainedLine: "logged",
      shutdownLines: ["graceful shutdown: drained in-flight requests"],
      serving: { entry: "server.js", nodeEnv: "production", buildId: "present", devArtifacts: false },
      release: "abcdef1234567890",
    }),
  });
  const fields = out.stdout.trim().split("\n");
  assert.deepEqual(fields.slice(0, 5), ["bad=[]", "drain=drained", "exit=0", "late16=refused", "late143=refused"]);
  assert.equal(fields[6], "serving=entry:server.js nodeEnv:production build:present dev:none");
  assert.equal(fields[7], "release=abcdef1234567890");
  assert.equal(fields[8], "sigterm=40");
});

test("read_burst names the defect on a darwin-shaped burst and on a dev-shaped one", () => {
  const darwin = spawnSync("bash", ["-c", `source "$1"; read_burst`, "--", script], {
    encoding: "utf8",
    input: JSON.stringify({
      n: 100,
      sigtermDelayMs: 40,
      inFlight: { requested: 100, non200: 1, statuses: { 200: 99, reset: 1 } },
      afterSigterm: { late16: "open", late143: "refused" },
      exit: { code: 1, signal: null },
      drainedLine: "absent",
      shutdownLines: ["graceful shutdown: drain timed out"],
      serving: { entry: "server.js", nodeEnv: "development", buildId: "missing", devArtifacts: true },
      release: null,
    }),
  });
  const fields = darwin.stdout.trim().split("\n");
  assert.equal(fields[0], "bad=[200:99 reset:1]");
  assert.equal(fields[1], "drain=absent");
  assert.equal(fields[2], "exit=1");
  assert.equal(fields[3], "late16=open");
  assert.ok(fields[5].includes("graceful shutdown: drain timed out"), "the printed line is quoted back");
  // A dev server would fail c0-serving, which is the point of carrying it in the document.
  assert.notEqual(fields[6], "serving=entry:server.js nodeEnv:production build:present dev:none");
  assert.equal(fields[7], "release=none");
});



// ---------------------------------------------------------------- 6. the SIGTERM pin actually matches
//
// The first gate pinned the protocol with `grep 'setTimeout(r, 40)'`, which the harness never
// contained: it names the constant (BURST_SIGTERM_DELAY_MS, default 40) and passes that to
// the setTimeout. On Linux that pin failed before the first run, so the gate could never
// produce the receipt it exists to produce. These cases keep the pin honest in both
// directions: it matches the real harness, and it rejects a harness whose delay moved.
const burstPath = path.join(path.dirname(script), "..", "drain-burst.mjs");

test("the SIGTERM-40ms pin matches the harness it pins", () => {
  assert.equal(call(`harness_pin "$@"`, [burstPath]).status, 0, "the real harness must satisfy the pin");
  const harness = readFileSync(burstPath, "utf8");
  assert.match(harness, /setTimeout\(r, SIGTERM_DELAY_MS\)/, "the harness fires SIGTERM with the constant");
});

test("the pin rejects a harness whose delay moved", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-gate-pin-"));
  try {
    const harness = readFileSync(burstPath, "utf8");
    const movedDefault = path.join(dir, "moved-default.mjs");
    // replaceAll: the file defaults two things to "40" (the N and the SIGTERM delay); the pin
    // must notice the SIGTERM one moving.
    writeFileSync(movedDefault, harness.replaceAll('?? "40"', '?? "39"'));
    assert.equal(call(`harness_pin "$@"`, [movedDefault]).status, 1, "a 39 ms default must fail the pin");

    const movedCall = path.join(dir, "moved-call.mjs");
    writeFileSync(movedCall, harness.replace("setTimeout(r, SIGTERM_DELAY_MS)", "setTimeout(r, 39)"));
    assert.equal(call(`harness_pin "$@"`, [movedCall]).status, 1, "a 39 ms call must fail the pin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an overridden BURST_SIGTERM_DELAY_MS is refused, so the protocol cannot drift", () => {
  assert.equal(call(`harness_delay_ok`, []).status, 0, "unset means 40");
  const drift = spawnSync("bash", ["-c", `source "$1"; harness_delay_ok`, "--", script], {
    encoding: "utf8",
    env: { ...process.env, BURST_SIGTERM_DELAY_MS: "5" },
  });
  assert.equal(drift.status, 1, "a 5 ms delay is a different protocol");
});

// ---------------------------------------------------------------- 7. build isolation
//
// W83 hit this: `next build` rewrote `.next` under a live `next dev`. Production mode must
// therefore build in a copy. These cases prove the copy is a copy: sources arrive, the heavy
// and generated directories do not, node_modules is a symlink, and the source tree's `.next`
// is left exactly as it was.
test("prepare_build_root copies sources, hardlinks dependencies and never touches .next", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sho-gate-isolation-"));
  const src = path.join(base, "src-tree");
  const dest = path.join(base, "dest-tree");
  try {
    mkdirSync(path.join(src, "src", "lib"), { recursive: true });
    mkdirSync(path.join(src, "node_modules", "next", "dist", "bin"), { recursive: true });
    mkdirSync(path.join(src, ".next", "dev"), { recursive: true });
    mkdirSync(path.join(src, ".git"), { recursive: true });
    writeFileSync(path.join(src, "server.js"), "// entry\n");
    writeFileSync(path.join(src, "package.json"), "{}\n");
    writeFileSync(path.join(src, "src", "lib", "shutdown.ts"), "export {};\n");
    writeFileSync(path.join(src, "node_modules", "next", "dist", "bin", "next"), "#!/usr/bin/env node\n");
    writeFileSync(path.join(src, ".next", "dev", "marker"), "dev\n");
    writeFileSync(path.join(src, ".git", "config"), "gitdir\n");

    const out = call(`prepare_build_root "$@"`, [src, dest]);
    assert.equal(out.status, 0, out.stdout + out.stderr);

    assert.ok(existsSync(path.join(dest, "server.js")), "sources are copied");
    assert.ok(existsSync(path.join(dest, "src", "lib", "shutdown.ts")), "src/ is copied");
    assert.ok(!existsSync(path.join(dest, ".next")), "a dev server's .next is not copied");
    assert.ok(!existsSync(path.join(dest, ".git")), ".git is not copied");
    assert.equal(readFileSync(path.join(dest, "node_modules", "next", "dist", "bin", "next"), "utf8"), "#!/usr/bin/env node\n", "dependencies resolve inside the copy");
    assert.ok(!existsSync(path.join(dest, "node_modules", ".cache")), "the shared cache is dropped");
    assert.ok(existsSync(path.join(src, ".next", "dev", "marker")), "the source .next is untouched");
    assert.ok(!existsSync(path.join(src, ".next", "BUILD_ID")), "no build was written into the source tree");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The real checkout, not a synthetic one: preparing a build root from THIS worktree must
// leave `.next` exactly as the live dev server left it.
test("preparing a build root from this checkout writes nothing into its .next", () => {
  const root = path.resolve(path.dirname(script), "..", "..");
  const buildIdPath = path.join(root, ".next", "BUILD_ID");
  const before = existsSync(buildIdPath) ? readFileSync(buildIdPath, "utf8") : null;
  const hadDev = existsSync(path.join(root, ".next", "dev"));
  const base = mkdtempSync(path.join(tmpdir(), "sho-gate-realroot-"));
  try {
    const out = call(`prepare_build_root "$@"`, [root, path.join(base, "app")]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(existsSync(path.join(base, "app", "server.js")), "the entry is in the copy");
    assert.ok(!existsSync(path.join(base, "app", ".next")), "no dev artifacts in the copy");
    assert.equal(existsSync(buildIdPath), before !== null, "the checkout's existing build-id presence is unchanged");
    assert.equal(existsSync(path.join(root, ".next", "dev")), hadDev, "the dev server's directory is unchanged");
    assert.equal(before, existsSync(buildIdPath) ? readFileSync(buildIdPath, "utf8") : null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
