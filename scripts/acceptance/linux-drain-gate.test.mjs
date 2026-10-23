// SHO-2689 — the Linux drain gate must be INCAPABLE of a darwin pass.
//
// The gate's verdict is a pure function of (kernel, evidence). These tests hand it
// forged evidence — every protocol condition satisfied — on a non-Linux kernel and
// require REFUSED/3; and they run the real script on this host and require the refusal
// transcript. Run with:
//   node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const source = readFileSync(script, "utf8");

function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Exercise the verdict function directly: no sockets, no files, just the decision.
function verdict(kernel, evidenceOk) {
  const out = spawnSync("bash", ["-c", `source ${script}; gate_verdict "$1" "$2"`, "--", kernel, evidenceOk], {
    encoding: "utf8",
  });
  return { verdict: out.stdout.trim(), status: out.status };
}

test("a non-Linux kernel cannot return PASS even when every condition is satisfied", () => {
  for (const kernel of ["Darwin", "FreeBSD", "MINGW64_NT-10.0", "SunOS", "unknown", ""]) {
    const got = verdict(kernel, "true");
    assert.equal(got.verdict, "REFUSED", `kernel ${JSON.stringify(kernel)} with all evidence true`);
    assert.equal(got.status, 3, `kernel ${JSON.stringify(kernel)} exit code`);
    assert.ok(!got.verdict.includes("PASS"), `kernel ${JSON.stringify(kernel)} must not print PASS`);
  }
});

test("the verdict is not vacuous: Linux passes only on satisfied evidence", () => {
  assert.deepEqual(verdict("Linux", "true"), { verdict: "PASS", status: 0 });
  assert.deepEqual(verdict("Linux", "false"), { verdict: "FAIL", status: 1 });
});

test("the kernel branch precedes the only PASS in the source", () => {
  const fnStart = source.indexOf("gate_verdict() {");
  const fnEnd = source.indexOf("read_burst() {", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, "gate_verdict must exist as its own function");
  const fn = source.slice(fnStart, fnEnd);
  const kernelBranch = fn.indexOf('if [ "$kernel" != "Linux" ]; then');
  const passEmitter = fn.indexOf("printf 'PASS'");
  assert.ok(kernelBranch > 0, "gate_verdict must branch on the kernel");
  assert.ok(passEmitter > kernelBranch, "in gate_verdict, PASS sits below the kernel branch");
  assert.ok(fn.slice(kernelBranch, passEmitter).includes("return 3"), "the kernel branch returns REFUSED");

  // And in the run path, the single GATE=PASS statement is below the kernel refusal.
  const mainKernelCheck = source.indexOf('if [ "$kernel" != "Linux" ]; then', fnEnd);
  assert.equal(source.split("printf 'GATE=PASS").length - 1, 1, "exactly one GATE=PASS statement");
  assert.ok(source.indexOf("printf 'GATE=PASS") > mainKernelCheck, "GATE=PASS is printed below the refusal");
  assert.ok(!/printf 'GATE=PASS/.test(source.slice(0, mainKernelCheck)), "no GATE=PASS above the refusal");
});

const isLinux = process.platform === "linux";

test("on this host the real script refuses, exit 3, and runs no burst", { skip: isLinux && "Linux host: the refusal path is not the one under test" }, () => {
  const out = run([]);
  assert.equal(out.status, 3, `exit code\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/, "first line verbatim");
  assert.ok(!/^RUN \d/m.test(out.stdout), "no burst may run");
  assert.ok(!/GATE=PASS/.test(out.stdout), "no pass line");
  assert.ok(!/RELEASE=/.test(out.stdout), "the release line is only printed on Linux");
});

test("the refusal outranks the argument check (check precedes every other branch)", { skip: isLinux && "Linux host" }, () => {
  // No SHA given: on Linux this is a usage error, here the kernel must win.
  const out = run(["deadbeef"]);
  assert.equal(out.status, 3);
  assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/);
});

test("--explain prints the conditions and the verbatim lines, with no side effects", () => {
  const out = run(["--explain"]);
  assert.equal(out.status, 0, out.stderr);
  for (const needle of [
    "c1-bad",
    "c2-drain",
    "c3-exit",
    "c4-probe",
    "bad=[]",
    "graceful shutdown: drained in-flight requests",
    "graceful shutdown: drain timed out",
    "late16=refused late143=refused",
    "GATE=PASS runs=5 n=100 release=<sha-under-test>",
    "GATE=REFUSED reason=not-linux",
    "N=100",
    "SIGTERM 40 ms",
  ]) {
    assert.ok(out.stdout.includes(needle), `--explain must mention ${needle}`);
  }
  assert.ok(!/^RUN \d/m.test(out.stdout), "no burst");
  assert.ok(!out.stdout.includes(process.env.DATABASE_URL ?? "\u0000"), "never prints the database url");
});


// The Linux-side field mapping is testable without Linux: it is only parsing. This
// proves the run loop's conditions read a real drain-burst document correctly, so a
// PASS on Linux would have to come from a real burst, not a parse slip.
function readBurst(json) {
  const out = spawnSync("bash", ["-c", `source ${script}; read_burst`], {
    encoding: "utf8",
    input: JSON.stringify(json),
  });
  return out.stdout.trim().split("\n");
}

test("read_burst maps a clean Linux burst to the four satisfied conditions", () => {
  const fields = readBurst({
    n: 100,
    inFlight: { requested: 100, non200: 0, statuses: { 200: 100 } },
    afterSigterm: { late16: "refused", late143: "refused" },
    exit: { code: 0, signal: null },
    drainedLine: "logged",
    shutdownLines: ["graceful shutdown: drained in-flight requests"],
  });
  assert.deepEqual(fields.slice(0, 5), [
    "bad=[]",
    "drain=drained",
    "exit=0",
    "late16=refused",
    "late143=refused",
  ]);
});

test("read_burst names the defect on a darwin-shaped burst", () => {
  const fields = readBurst({
    n: 100,
    inFlight: { requested: 100, non200: 1, statuses: { 200: 99, reset: 1 } },
    afterSigterm: { late16: "open", late143: "refused" },
    exit: { code: 1, signal: null },
    drainedLine: "absent",
    shutdownLines: ["graceful shutdown: drain timed out"],
  });
  assert.equal(fields[0], "bad=[200:99 reset:1]");
  assert.equal(fields[1], "drain=absent");
  assert.equal(fields[2], "exit=1");
  assert.equal(fields[3], "late16=open");
  assert.ok(fields[5].includes("graceful shutdown: drain timed out"), "the printed line is quoted back");
});
