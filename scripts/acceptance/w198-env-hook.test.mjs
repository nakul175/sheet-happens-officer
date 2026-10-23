// W198 — the darwin refusal is still not total: `BASH_ENV` is a hook into the gate's OWN shell.
//
// W184 replaced `uname -s` with /proc/sys/kernel/ostype + /proc/version, read with bash
// builtins, and argued "a file no environment variable can rewrite" (linux-drain-gate.sh:95-112).
// The file cannot be rewritten — but the VARIABLE NAMES that point at it can be, and on darwin
// the files under those names do not exist, so the only thing between the caller and the Linux
// branch is which path the `read` redirection opens.
//
// `BASH_ENV` is sourced by every non-interactive bash BEFORE the script's first line. With
// `set -T` a DEBUG trap set there is inherited INTO the script's functions and runs before each
// command in them. GATE_PROCFS_OSTYPE / GATE_PROCFS_VERSION are assigned unconditionally at load
// (lines 119-120), which defeats an environment copy of those names — but the DEBUG trap
// re-assigns them after the load and before `local ostype_file="${1:-$GATE_PROCFS_OSTYPE}"`
// (line 127) reads them. Two forged one-line files then answer "Linux" twice.
//
// Measured on this darwin host (W198):
//   BASH_ENV=<trap> bash linux-drain-gate.sh --dev deadbeef11
//     -> GATE=FAIL missing-database-url, EXIT=1   (past the kernel refusal, in the run path)
//   the same, with a fake release root and a `node` that answers release-id/build/burst:
//     -> GATE=PASS runs=1 n=100 release=deadbeef11 entry=server.js, EXIT=0   (on darwin)
//
// So the authority was not the kernel's answer: it was a shell variable in a shell whose startup
// file the caller chose. This file was the red receipt — it failed on the tree as of 1366bdf.
// W214 closed it with ONE early branch: linux-drain-gate.sh:79-95 refuses at load
// (GATE=REFUSED reason=environment-hook, exit 3) when BASH_ENV/ENV is set or a DEBUG trap is
// installed, and main() plus both inner runners re-assert the same function, so the CLI case and
// the sourced-runner case below now assert THAT reason, on its own line, distinct from not-linux.
// Residual by decision: `--rcfile`, an inherited SHELLOPTS, or sourcing from an already-hooked
// shell are outside what a shell script can defend against.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const isLinux = process.platform === "linux";
const skip = isLinux ? "Linux host: the refusal path is not the one under test" : false;

const SHA = "deadbeef11";

/**
 * Forged "Linux" markers plus a BASH_ENV file whose DEBUG trap points the gate's marker
 * variables at them. Nothing here touches /proc, the checkout, or a real kernel.
 */
function forgedHook() {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-w198-hook-"));
  writeFileSync(path.join(dir, "ostype"), "Linux\n");
  writeFileSync(path.join(dir, "version"), "Linux version 6.8.0-forged (gcc) #1 SMP\n");
  const env = path.join(dir, "bashenv");
  writeFileSync(
    env,
    ["set -T", `trap 'GATE_PROCFS_OSTYPE=${dir}/ostype GATE_PROCFS_VERSION=${dir}/version' DEBUG`, ""].join("\n"),
  );
  return { dir, env };
}

/** The CLI shape: a plain `bash gate.sh`, with BASH_ENV as the only help. */
function cli(args, env) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

/** The suite's own seam: source the file and call the runner directly. */
function call(body, args, env) {
  const out = spawnSync("bash", ["-c", `source "$1"; shift; ${body}`, "--", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: out.stdout, stderr: out.stderr, status: out.status };
}

test("control: with no BASH_ENV the same invocation does refuse (so the cases below are about the hook)", { skip }, () => {
  const out = cli(["--production", SHA], { DATABASE_URL: "", GATE_RUNS: "1" });
  assert.equal(out.status, 3, out.stdout + out.stderr);
  assert.match(out.stdout, /^GATE=REFUSED reason=not-linux\n/);
});

test("a BASH_ENV DEBUG trap cannot move the CLI past the kernel refusal", { skip }, () => {
  const { dir, env } = forgedHook();
  try {
    for (const mode of ["--production", "--dev"]) {
      const out = cli([mode, SHA], { BASH_ENV: env, DATABASE_URL: "", GATE_RUNS: "1" });
      assert.equal(
        out.status,
        3,
        `BASH_ENV defeated the kernel refusal for ${mode}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
      );
      assert.match(
        out.stdout,
        /^GATE=REFUSED reason=environment-hook\n/,
        `the first line must be the environment-hook refusal for ${mode} (W214: the hook is refused outright, not tolerated and then caught by the kernel)\n${out.stdout}`,
      );
      assert.ok(!/^GATE=MODE/m.test(out.stdout), `the mode was honoured on this kernel:\n${out.stdout}`);
      assert.ok(!/^BUILD=/m.test(out.stdout), `a build was started on this kernel:\n${out.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sourced runner reads the real kernel, not the caller's BASH_ENV", { skip }, () => {
  const { dir, env } = forgedHook();
  try {
    for (const fn of ["production_run", "dev_run"]) {
      // The token is supplied too, so the only thing left that can refuse is the kernel check:
      // otherwise the reason code would be no-platform-token — a token answer, not a kernel one.
      const out = call(`${fn} "$@"`, [SHA], {
        BASH_ENV: env,
        GATE_PLATFORM_TOKEN: "platform-checked-by-main",
        GATE_RUNS: "1",
      });
      assert.equal(
        out.status,
        3,
        `${fn} did not refuse on the kernel with BASH_ENV set\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
      );
      assert.match(
        out.stdout,
        /^GATE=REFUSED reason=environment-hook\n/,
        `${fn} answered with something other than the hook refusal:\n${out.stdout}`,
      );
      assert.ok(!/^BUILD=/m.test(out.stdout), `${fn} started a build before refusing:\n${out.stdout}`);
      assert.ok(!/^DEV=/m.test(out.stdout), `${fn} started a dev run before refusing:\n${out.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both inner runners re-assert the guard, so a shell hooked AFTER load is still refused", { skip }, () => {
  // The load-time refusal covers W198's shapes because the hook is present when the file is read.
  // This one covers the call the guard's own placement depends on: the file is loaded clean, then
  // the shell is hooked, and a runner is entered directly. The runner's own check — not the load
  // call, not the kernel — is what has to answer.
  const { dir, env } = forgedHook();
  try {
    for (const fn of ["production_run", "dev_run"]) {
      const out = call(`BASH_ENV="$HOOK" ${fn} "$@"`, [SHA], { HOOK: env, GATE_RUNS: "1" });
      assert.equal(out.status, 3, `${fn} ran in a hooked shell\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
      assert.match(out.stdout, /^GATE=REFUSED reason=environment-hook\n/, `${fn} printed no hook refusal:\n${out.stdout}`);
      assert.ok(!/^RUN \d/m.test(out.stdout), `${fn} ran a burst in a hooked shell:\n${out.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inherited DEBUG trap under functrace is refused too (the third clause)", { skip }, () => {
  // `set -T` is not decoration: it is the only way a DEBUG trap fires inside the gate's functions,
  // and on bash 3.2 (this host) it is also the only way `trap -p DEBUG` reports one at all. A trap
  // without functrace cannot reach a marker read and is not what the guard claims to catch.
  const out = spawnSync("bash", ["-c", 'trap \':\' DEBUG; set -T; source "$1"', "--", script], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(out.status, 3, out.stdout + out.stderr);
  assert.match(out.stdout, /^GATE=REFUSED reason=environment-hook\n/, out.stdout);
});

test("no invocation on this host can print GATE=PASS, even with the hook and a forged release", { skip }, () => {
  // The end-to-end consequence. A fake release root satisfies the directory rule and a `node` on
  // PATH answers the three questions the gate asks it (release-id, --build-id, the burst JSON)
  // with a clean drain. If the kernel check holds, none of that is ever reached. On the tree as
  // of 1366bdf this prints GATE=PASS and exits 0 on darwin.
  const { dir, env } = forgedHook();
  const bin = path.join(dir, "bin");
  const app = path.join(dir, "release");
  const burst = path.join(dir, "burst.json");
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(app, ".next"), { recursive: true });
    writeFileSync(path.join(app, "server.js"), "");
    writeFileSync(path.join(app, ".next", "BUILD_ID"), "FAKE\n");
    writeFileSync(
      burst,
      `${JSON.stringify({
        inFlight: { statuses: { 200: 100 }, non200: 0 },
        drainedLine: "logged",
        exit: { code: 0 },
        afterSigterm: { late16: "refused", late143: "refused" },
        shutdownLines: ["graceful shutdown: drained in-flight requests"],
        serving: { entry: "server.js", nodeEnv: "production", buildId: "present", devArtifacts: false },
        release: SHA,
        sigtermDelayMs: 40,
      })}\n`,
    );
    writeFileSync(
      path.join(bin, "node"),
      [
        "#!/bin/sh",
        'case "$*" in',
        "  *release-identity.mjs*--match*) exit 0 ;;",
        '  *release-identity.mjs*--build-id*) echo "RELEASE-IDENTITY=build-id=FAKE"; exit 0 ;;',
        '  *release-identity.mjs*) echo "RELEASE-IDENTITY=release build-id=FAKE entry=server.js"; exit 0 ;;',
        `  *drain-burst.mjs*) cat "${burst}"; exit 0 ;;`,
        `  *-e*) exec "${process.execPath}" "$@" ;;`,
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(bin, "node"), 0o755);

    const out = spawnSync("bash", [script, "--production", SHA], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: env,
        PATH: `${bin}:${process.env.PATH}`,
        DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x",
        GATE_BUILD_ROOT: app,
        GATE_RUNS: "1",
      },
    });
    assert.ok(
      !/^GATE=PASS/m.test(out.stdout),
      `GATE=PASS was printed on this host for a release that was never built:\nstdout:\n${out.stdout}`,
    );
    assert.equal(out.status, 3, `the only answer on this kernel is exit 3\nstdout:\n${out.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

