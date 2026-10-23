// CONTAINMENT (slot 9) — the pre-start gate vs the post-start proof.
//
// The rule is "no candidate execution on slot 9 until PROOF=PASS". It was circular: slot9-proof.sh failed
// closed at P2 with `[ -n "$pid" ] && [ "$pid" != '0' ] || fail "… has no MainPID"`, so the script could not
// run before the unit it was meant to authorise had started — and R6 exits 4 until that start. These tests
// pin the split: `--pre-start` must answer with nothing running, and the full run must keep its contract
// and print CONTAINMENT= before gap_closed=/PROOF=.
//
// The sandbox technique is the one unit-env-sources.test.mjs uses (copy the real script, redirect its host
// paths and its root/systemd preconditions into a temp dir), so what runs here is the real verdict code.
// It is a small COPY rather than an import on purpose: importing a *.test.mjs re-registers that file's
// tests inside this process, so the suite would report its cases (and its 1 todo) twice and the counts
// could no longer be quoted. Nothing here executes on the host: no sudo, no systemd, no ssh, no /etc.
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const PROOF = join(here, "slot9-proof.sh");
const LIB = join(here, "lib", "unit-env-sources.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");
const MARKERS = "defaultdb|doadmin|25061|sho-prod-pool";

// A four-source, four-guard unit — the shape R4 renders.
function unitText(slot) {
  const sources = [
    `${slot}/env/db.env`,
    `${slot}/env/app.env`,
    `${slot}/env/local.env`,
    `${slot}/current/release.env`,
  ];
  const lines = ["[Unit]", "Description=sandbox", "", "[Service]"];
  sources.forEach((p, i) => lines.push(`EnvironmentFile=${i < 2 ? "" : "-"}${p}`));
  sources.forEach((p) => lines.push(
    `ExecStartPre=/bin/sh -c 'test ! -e ${p} || { test -r ${p} && ! grep -qEi -- "${MARKERS}" ${p}; }'`,
  ));
  return `${lines.join("\n")}\n`;
}

// `running: false` models the state the gate exists for: the unit has been rendered but never started, so
// systemctl answers and MainPID is empty, and nothing listens on 3109.
function build({ prodEnvReadable = false, unitFile = true, running = true, positiveControl = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-gates-"));
  for (const sub of ["slot/env", "slot/current", "sho", "deploy/.ssh", "lib", "unitdir", "bin", "evil", "outside", "proc"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  writeFileSync(join(dir, "sho", "app.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(dir, "sho", "app.env.bak-20261019-115253"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "deploy", ".ssh", "authorized_keys"), "ssh-ed25519 AAAA sandbox\n");
  writeFileSync(join(slot, "env", "db.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(slot, "env", "app.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "env", "extra.env"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "evil", "extra.env"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "outside", "release.env"), "NODE_ENV=production\n");
  if (unitFile) writeFileSync(join(dir, "unitdir", "sho-pr9.service"), unitText(slot));

  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  let pid = "";
  if (running) {
    // A live process this test owns, with a sandbox /proc stand-in carrying real NUL separators (macOS has
    // no /proc; the full run's P2 reads would otherwise be untestable off Linux).
    const sleeper = spawnSync("bash", ["-c", "sleep 20 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    pid = sleeper.stdout.trim();
    mkdirSync(join(dir, "proc", pid), { recursive: true });
    writeFileSync(join(dir, "proc", pid, "environ"), "NODE_ENV=production\0DATABASE_URL=postgres://sho@127.0.0.1:5432/x\0");
    stub("systemctl", `for a in "$@"; do [ "$a" = "MainPID" ] && { echo ${pid}; exit 0; }; done\nexit 0`);
  } else {
    // Rendered, never started: systemctl exists, MainPID is empty/0.
    stub("systemctl", "exit 0");
  }
  stub("ss", running ? `echo "LISTEN 0 511 127.0.0.1:3109 0.0.0.0:*"` : "exit 0");
  stub("curl", `for a in "$@"; do [ "$a" = "-o" ] && { printf 200; exit 0; }; done\nprintf '{"ok":true,"release":"deadbeef"}'`);
  stub("pgrep", "exit 1");

  // as_slot's real contract: 0 = the probe SUCCEEDED (the slot could do it), 1 = denied.
  const prodEnv = join(dir, "sho", "app.env");
  const control = positiveControl ? "echo 0" : "echo 1";
  const readable = prodEnvReadable ? "echo 0" : "echo 1";
  const asSlot = `as_slot() { case "$*" in "test -e /") ${control} ;; "test -r ${prodEnv}") ${readable} ;; *) echo 1 ;; esac; }`;

  const patched = readFileSync(PROOF, "utf8")
    .replaceAll("/etc/systemd/system/", `${dir}/unitdir/`)
    .replaceAll("/home/shoslot/pr9", slot)
    .replaceAll("/home/deploy", `${dir}/deploy`)
    .replaceAll("/etc/sho", `${dir}/sho`)
    .replaceAll("/proc/", `${dir}/proc/`)
    .replaceAll('$(id -u "$SLOT_ACCOUNT")', "9001")
    .replace(/^\[ "\$\(id -u\)" -eq 0 \].*$/m, '[ -n "$FAKE_ROOT" ] || fail "needs root"')
    .replace(/^\[ "\$\(uname -s\)" = 'Linux' \].*$/m, ":")
    .replace(/^id -u "\$SLOT_ACCOUNT".*$/m, ":")
    .replace(/^as_slot\(\).*$/m, () => asSlot)
    // Harness artifact, not a script defect: macOS ships bash 3.2, which cannot parse `case … esac` inside a
    // command substitution in a double-quoted string. These two P5 lines are informational and feed no
    // verdict term, so the sandbox drops them (the same accommodation unit-env-sources.test.mjs records).
    .replace(/^say "dsn_is_loopback=.*$/m, ": # bash 3.2 parse artifact (harness only)")
    .replace(/^say "dsn_port_5432=.*$/m, ": # bash 3.2 parse artifact (harness only)");
  writeFileSync(join(dir, "proof.sh"), patched);

  const run = (...args) => {
    const res = spawnSync("bash", [join(dir, "proof.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_ROOT: "1" },
    });
    if (pid) { try { process.kill(Number(pid)); } catch { /* already gone is fine */ } }
    return res;
  };
  return { dir, slot, run };
}

const verdict = (stdout) => /^CONTAINMENT=(PASS|FAIL)\b/m.exec(stdout)?.[1] ?? "(no CONTAINMENT line)";
const p4 = (stdout) => stdout.split("\n").find((l) => l.startsWith("unit_envfile_count=")) ?? "(no P4 line)";

// ---------------------------------------------------------------------------
// 1. The gate must be answerable with nothing running.
// ---------------------------------------------------------------------------
test("pre-start: a rendered-but-never-started unit gets a VERDICT, not the MainPID refusal", () => {
  const res = build({ running: false }).run("--pre-start");
  assert.equal(res.status, 0, `${p4(res.stdout)}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /CONTAINMENT=PASS/, `no verdict line:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /has no MainPID/, "P2 must not be answerable in pre-start mode");
  // A pre-start run is not a proof run: it must never look like one.
  assert.doesNotMatch(res.stdout, /PROOF=|gap_closed=/, `a gate run claimed to be the full proof:\n${res.stdout}`);
});

test("pre-start: the alias --containment is the same gate", () => {
  const res = build({ running: false }).run("--containment");
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(verdict(res.stdout), "PASS");
});

// ---------------------------------------------------------------------------
// 2. The inversion w78 fixed must not come back through the new mode.
// ---------------------------------------------------------------------------
test("pre-start: a slot that CAN read the production env yields CONTAINMENT=FAIL and exit 1", () => {
  const res = build({ running: false, prodEnvReadable: true }).run("--pre-start");
  assert.equal(res.status, 1, `an open gap was not failed:\n${res.stdout}\n${res.stderr}`);
  assert.equal(verdict(res.stdout), "FAIL", res.stdout);
  assert.doesNotMatch(res.stdout, /CONTAINMENT=PASS/);
});

test("pre-start: the denial it relies on is printed, not assumed", () => {
  const res = build({ running: false }).run("--pre-start");
  assert.match(res.stdout, /shoslot_can_read_prod_env=1/, "P1 must show the denial in the gate run too");
  assert.match(res.stdout, /probe_positive_control=1/);
});

// ---------------------------------------------------------------------------
// 3. Exit 2 stays reserved for real preconditions.
// ---------------------------------------------------------------------------
test("pre-start: refuses (exit 2) when the unit file has not been rendered", () => {
  const res = build({ running: false, unitFile: false }).run("--pre-start");
  assert.equal(res.status, 2, `expected a precondition refusal:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /REFUSING:.*absent/);
  assert.doesNotMatch(res.stdout, /CONTAINMENT=/, "a missing unit must not produce a verdict");
});

test("pre-start: refuses (exit 2) when the positive control cannot run", () => {
  const res = build({ running: false, positiveControl: false }).run("--pre-start");
  assert.equal(res.status, 2, `expected a precondition refusal:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /positive|known-good probe/);
});

test("pre-start: an unknown flag is refused rather than silently treated as the full run", () => {
  const res = build({ running: false }).run("--prestart");
  assert.equal(res.status, 2, `a typo must not run the wrong gate:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /unknown argument/);
});

// ---------------------------------------------------------------------------
// 4. The full run keeps its contract, and is distinguishable from the gate.
// ---------------------------------------------------------------------------
test("full: still prints CONTAINMENT= before gap_closed=/PROOF=, and PASSes on a clean sandbox", () => {
  const res = build().run();
  assert.equal(res.status, 0, `${p4(res.stdout)}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /PROOF=PASS/);
  assert.equal(verdict(res.stdout), "PASS");
  const out = res.stdout;
  assert.ok(out.indexOf("CONTAINMENT=PASS") < out.indexOf("gap_closed="), "CONTAINMENT must precede gap_closed");
  assert.ok(out.indexOf("CONTAINMENT=PASS") < out.indexOf("PROOF="), "CONTAINMENT must precede PROOF=");
});

test("full: still FAILs on the readable-production-env sandbox", () => {
  const res = build({ prodEnvReadable: true }).run();
  assert.equal(res.status, 1, `${p4(res.stdout)}\n${res.stdout}`);
  // PROOF=FAIL has always been a stderr line (the runbook greps it there); CONTAINMENT= is on stdout.
  assert.match(res.stderr, /PROOF=FAIL/);
  assert.equal(verdict(res.stdout), "FAIL", "the full run must retract, not grant");
  assert.doesNotMatch(res.stdout, /PROOF=PASS/);
});

test("full: a stopped unit is still refused at P2 (the post-start contract is unchanged)", () => {
  const res = build({ running: false }).run();
  assert.equal(res.status, 2, `the full run must still require a MainPID:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /has no MainPID/);
});

