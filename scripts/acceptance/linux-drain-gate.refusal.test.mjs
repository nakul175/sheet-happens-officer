// SHO-2689 — the darwin refusal is not TOTAL, and these two tests reproduce the holes.
//
// linux-drain-gate.sh:527-538 puts the kernel check first in main(), so every documented CLI
// shape refuses on darwin (linux-drain-gate.test.mjs:130-141). But `main` is not the only way
// into the gate's production path:
//
//   1. the kernel is `uname -s` resolved through PATH (linux-drain-gate.sh:530). One directory
//      ahead of /usr/bin on PATH holding a two-line `uname` that echoes Linux is enough to make
//      a darwin host take the Linux branch, past the refusal, into the mode dispatch and the
//      burst. Nothing else in the file re-checks the kernel before production_run/dev_run.
//   2. production_run() (linux-drain-gate.sh:449) and dev_run() (linux-drain-gate.sh:488) carry
//      no kernel check of their own — only main() does. A sourced call, which the test suite
//      itself uses as its seam (`call()` in linux-drain-gate.test.mjs:33), reaches the build and
//      the burst on darwin and only asks gate_verdict() AFTER run_bursts() has returned
//      (linux-drain-gate.sh:467-470).
//
// Both are asserted as "must refuse" so that a fix turns them green; both fail on the current
// tree. Nothing here starts a burst: case 1 stops at the missing-DATABASE_URL guard once the
// kernel branch is passed, and case 2 is pointed at an empty GATE_BUILD_ROOT so the
// precondition fails before a socket or a build.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const isLinux = process.platform === "linux";
const skip = isLinux ? "Linux host: the refusal path is not the one under test" : false;

const SHA = "deadbeef11";

test("a PATH override cannot move the gate past the kernel refusal", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-refusal-path-"));
  try {
    // A `uname` that answers like Linux for every question, ahead of the real one.
    writeFileSync(path.join(dir, "uname"), "#!/bin/sh\ncase \"$1\" in -m) echo x86_64 ;; *) echo Linux ;; esac\n");
    chmodSync(path.join(dir, "uname"), 0o755);

    const out = spawnSync("bash", [script, "--dev", SHA], {
      encoding: "utf8",
      // No DATABASE_URL: if the kernel branch is passed, the run stops at the next guard, so
      // this can never start a burst — it only shows which branch was taken.
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "", GATE_RUNS: "1" },
    });

    assert.equal(out.status, 3, `PATH must not defeat the refusal\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
    assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/, "the first line is still the refusal");
    assert.ok(!/^GATE=MODE/m.test(out.stdout), "no mode was honoured on this kernel");
    assert.ok(!/^RELEASE=/m.test(out.stdout), "no release line on this kernel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inner runners refuse on a non-Linux kernel on their own, not only via main()", { skip }, () => {
  const empty = mkdtempSync(path.join(tmpdir(), "sho-refusal-inner-"));
  try {
    for (const fn of ["production_run", "dev_run"]) {
      const out = spawnSync("bash", ["-c", `source "$1"; ${fn} "$2"`, "--", script, SHA], {
        encoding: "utf8",
        env: { ...process.env, GATE_BUILD_ROOT: empty, GATE_RUNS: "1" },
      });
      assert.equal(out.status, 3, `${fn} must refuse first\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
      assert.match(out.stdout, /GATE=REFUSED reason=not-linux|^REFUSED$/m, `${fn} printed no refusal:\n${out.stdout}`);
      assert.ok(!/^BUILD=/m.test(out.stdout), `${fn} started on a build before refusing:\n${out.stdout}`);
      assert.ok(!/^DEV=/m.test(out.stdout), `${fn} started a dev run before refusing:\n${out.stdout}`);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("control: the bare CLI, with no environment help, does refuse", { skip }, () => {
  const out = spawnSync("bash", [script, "--dev", SHA], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(out.status, 3, out.stdout + out.stderr);
  assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/);
});
