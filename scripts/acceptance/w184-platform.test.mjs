// W184 — the platform check cannot be defeated by the environment, and the inner runners refuse
// on their own. Companion to linux-drain-gate.refusal.test.mjs (W172's receipt), which asks the
// two questions that were RED before this change; this file adds the marker arguments, the
// token mechanism and the positive control that the Linux branch is still reachable.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const isLinux = process.platform === "linux";
const refusalSkip = isLinux ? "Linux host: the refusal path is not the one under test" : false;

const SHA = "deadbeef11";

function call(body, args = [], env = {}) {
  const out = spawnSync("bash", ["-c", `source "$1"; shift; ${body}`, "--", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

function fixtures(ostype, version) {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-w184-markers-"));
  writeFileSync(path.join(dir, "ostype"), ostype);
  writeFileSync(path.join(dir, "version"), version);
  return dir;
}

// ---------------------------------------------------------------- the marker itself
//
// The decision is /proc/sys/kernel/ostype AND /proc/version, read with bash builtins. These
// cases are a SIMULATION of the Linux branch on this host: they show the check is two-sided
// (a Linux marker is accepted, a darwin one is not), not always-refuse. They are not acceptance
// and they cannot make a darwin run pass — every run path calls the function with no arguments.

test("the marker accepts a kernel that says Linux twice, and nothing else", () => {
  const linux = fixtures("Linux\n", "Linux version 6.8.0-45-generic (gcc) #1 SMP\n");
  const darwinOstype = fixtures("Darwin\n", "Darwin Kernel Version 24.0.0\n");
  const darwinVersion = fixtures("Linux\n", "Darwin Kernel Version 24.0.0\n");
  const empty = mkdtempSync(path.join(tmpdir(), "sho-w184-empty-"));
  try {
    assert.equal(
      call(`platform_is_linux "$@"`, [path.join(linux, "ostype"), path.join(linux, "version")]).status,
      0,
      "a Linux marker pair is Linux",
    );
    assert.equal(
      call(`platform_is_linux "$@"`, [path.join(darwinOstype, "ostype"), path.join(darwinOstype, "version")]).status,
      1,
      "Darwin ostype is not Linux",
    );
    assert.equal(
      call(`platform_is_linux "$@"`, [path.join(darwinVersion, "ostype"), path.join(darwinVersion, "version")]).status,
      1,
      "ostype alone is not enough: a forged bare word does not satisfy /proc/version",
    );
    assert.equal(
      call(`platform_is_linux "$@"`, [path.join(empty, "absent"), path.join(empty, "absent-version")]).status,
      1,
      "no marker means no Linux: the gate fails closed",
    );
  } finally {
    for (const dir of [linux, darwinOstype, darwinVersion, empty]) rmSync(dir, { recursive: true, force: true });
  }
});

test("this host is not Linux by the marker, and main() refuses on that answer alone", { skip: refusalSkip }, () => {
  assert.notEqual(call("platform_is_linux").status, 0, "this host must not answer Linux");
  assert.equal(call("platform_kernel").stdout, "", "main branches on the marker, which is empty here");
  const out = spawnSync("bash", [script, "--dev", SHA], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(out.status, 3, out.stdout + out.stderr);
  assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/);
});


// ---------------------------------------------------------------- the token mechanism

test("the internal token exists only after main() mints it", () => {
  const bare = call("require_platform_token");
  assert.equal(bare.status, 3, "without the token the runner refuses");
  assert.match(bare.stdout, /^GATE=REFUSED reason=no-platform-token\n/);

  const minted = call("grant_platform_token; require_platform_token");
  assert.equal(minted.status, 0, "main's grant is what opens the runner");
  assert.equal(minted.stdout, "", "the grant itself prints nothing");
});

test("an exported GATE_PLATFORM_TOKEN cannot mint the token", () => {
  // The value is assigned unconditionally at load, so the environment's copy is overwritten
  // before it is read: the environment cannot mint it.
  const out = call("require_platform_token", [], { GATE_PLATFORM_TOKEN: "platform-checked-by-main" });
  assert.equal(out.status, 3, "the environment cannot mint the token");
  assert.match(out.stdout, /reason=no-platform-token/);
});

test("a sourced call carrying a forged token still refuses on this kernel", { skip: refusalSkip }, () => {
  for (const fn of ["production_run", "dev_run"]) {
    const out = call(`${fn} "$@"`, [SHA], { GATE_PLATFORM_TOKEN: "platform-checked-by-main", GATE_BUILD_ROOT: "", GATE_RUNS: "1" });
    assert.equal(out.status, 3, `${fn} must refuse on the kernel before it looks at the token\n${out.stdout}`);
    assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/, `${fn} must print the kernel refusal first`);
    assert.ok(!/^BUILD=/m.test(out.stdout), `${fn} must not start a build`);
    assert.ok(!/^DEV=/m.test(out.stdout), `${fn} must not start a dev run`);
  }
});

// ---------------------------------------------------------------- the linux branch is reachable
//
// gate_verdict() is the existing seam: it takes the kernel as an argument, so the Linux decision
// can be driven on any host. This is the SAME simulation the earlier tests use, and it is not
// acceptance: only a Linux kernel can produce a GATE=PASS, because main() and both runners read
// the real procfs.

test("the Linux side of the decision is still reachable (simulation, not acceptance)", () => {
  const pass = call(`gate_verdict "$@"`, ["Linux", "production", "true"]);
  assert.equal(pass.status, 0, pass.stdout);
  assert.equal(pass.stdout, "PASS");
  const refused = call(`gate_verdict "$@"`, ["Darwin", "production", "true"]);
  assert.equal(refused.status, 3);
  assert.equal(refused.stdout, "REFUSED");
});

test("a PATH shim for `cat`/`head`/`tr`/`uname` cannot help: the marker uses no external program", { skip: refusalSkip }, () => {
  // The original hole was a shimmed `uname`. The marker reads procfs with bash builtins, so the
  // same attack on the tools a naive check would use must also fail.
  const dir = mkdtempSync(path.join(tmpdir(), "sho-w184-catshim-"));
  try {
    for (const name of ["cat", "head", "tr", "uname"]) {
      writeFileSync(path.join(dir, name), "#!/bin/sh\necho Linux\n");
      chmodSync(path.join(dir, name), 0o755);
    }
    const out = spawnSync("bash", [script, "--production", SHA], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "" },
    });
    assert.equal(out.status, 3, `stdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
    assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
