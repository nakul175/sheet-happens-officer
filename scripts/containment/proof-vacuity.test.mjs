// CONTAINMENT (slot 9) — RED-TEAM, w102: a control that was never OBSERVED must not read as satisfied.
//
// The doctrine the script states about itself (slot9-proof.sh:18, :84-88) is "a denial alone proves nothing:
// a missing file is also denied, so each probe reports EXISTS and DENIED separately, and PASS requires both".
// It applies that rule to /etc/sho/app.env and to the .bak copy. It does NOT apply it to two controls the
// verdict's own sentence leans on:
//
//   * `shoslot_can_write_authorized_keys` (slot9-proof.sh:285-290). `as_slot test -w <path>` answers "denied"
//     (1) for a file that does not exist, so a host with NO authorized_keys to plant a key in prints the
//     passing value and CONTAINMENT=PASS. The script knows: it prints an INFO line saying the denial is
//     vacuous - but that line is not a term, so the verdict still says PASS. `authorized_keys` is the SSH
//     persistence path the claim names explicitly.
//   * `listen_on_3109_count` (slot9-proof.sh:374-375). Printed with "(expect >=1)" and consumed by nothing:
//     no containment/PROOF term reads it, so a host where `ss` is absent (iproute2 not installed) prints 0 -
//     the script's own "expect" violated - and still reaches PROOF=PASS.
//
// Both are the class of defect the header says was paid for once ("P3 printed systemctl show and nothing
// consumed it"), so both are pinned behaviourally: the real script runs against a temp-dir sandbox and the
// assertions read its verdict, not its source text.
//
// Offline and macOS-safe: no host, no root, no sudo, no systemd, no ssh, no /etc/sho - the same technique as
// proof-gates.test.mjs / proof-verdict-terms.test.mjs (copy the script, redirect its host paths and its
// root/Linux preconditions into a temp dir, answer systemctl/pgrep from proof-sandbox.mjs).
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containmentLines, pgrepBody, systemctlBody } from "./proof-sandbox.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PROOF = join(here, "slot9-proof.sh");
const LIB = join(here, "lib", "unit-env-sources.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");
const MARKERS = "defaultdb|doadmin|25061|sho-prod-pool";

function unitText(slot, shoDir) {
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
  lines.push(...containmentLines({ shoDir }));
  return `${lines.join("\n")}\n`;
}

// `authKeys: false` = the deployer has no authorized_keys file at all. That is the host the vacuity rule is
// about: there is no key file to plant a key in, so "the slot cannot write it" was not measured.
// `ssListens: false` = `ss` answers nothing (the tool is absent, as on any host without iproute2).
function build({ authKeys = true, ssListens = true, running = true, staleCopyReadable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-vacuity-"));
  for (const sub of ["slot/env", "slot/current", "sho", "deploy/.ssh", "lib", "unitdir", "bin", "proc"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  const shoDir = join(dir, "sho");
  writeFileSync(join(shoDir, "app.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(shoDir, "app.env.bak-20261019-115253"), "NODE_ENV=production\n");
  if (authKeys) writeFileSync(join(dir, "deploy", ".ssh", "authorized_keys"), "ssh-ed25519 AAAA sandbox\n");
  // A stale copy of the production env under a name the `app.env.bak*` glob does not match. slot9-proof.sh
  // probes exactly ONE hard-coded copy (`/etc/sho/app.env.bak-20261019-115253`) and only COUNTS the ones that
  // match `app.env.bak*`; a copy called `app.env.old` is neither counted nor probed.
  const staleCopy = join(shoDir, "app.env.old");
  writeFileSync(staleCopy, "DATABASE_URL=postgres://prod@db:5432/sho_prod\n");
  writeFileSync(join(slot, "env", "db.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(slot, "env", "app.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "env", "local.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "current", "release.env"), "PORT=3109\n");
  writeFileSync(join(dir, "unitdir", "sho-pr9.service"), unitText(slot, shoDir));

  const pids = [];
  const sleeper = () => {
    const s = spawnSync("bash", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    pids.push(s.stdout.trim());
    return s.stdout.trim();
  };
  let pid = "";
  if (running) {
    pid = sleeper();
    mkdirSync(join(dir, "proc", pid), { recursive: true });
    writeFileSync(
      join(dir, "proc", pid, "environ"),
      "NODE_ENV=production\0DATABASE_URL=postgres://sho@127.0.0.1:5432/x\0",
    );
  }
  const deploy = sleeper();


  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("systemctl", systemctlBody({ unitFile: join(dir, "unitdir", "sho-pr9.service"), mainPid: pid }));
  stub("ss", ssListens ? 'echo "LISTEN 0 511 127.0.0.1:3109 0.0.0.0:*"' : "exit 0");
  stub("curl", `for a in "$@"; do [ "$a" = "-o" ] && { printf 200; exit 0; }; done\nprintf '{"ok":true,"release":"deadbeef"}'`);
  stub("pgrep", pgrepBody(deploy));

  // as_slot's real contract: 0 = the probe SUCCEEDED (the slot could do it), 1 = denied. Every probe other
  // than the positive control is modelled as a denial, which is exactly what `test -w <missing file>` answers
  // - that equivalence IS the hole these tests are about, so the stub must not special-case it away.
  const prodEnv = join(shoDir, "app.env");
  const asSlot = `as_slot() { case "$*" in "test -e /") echo 0 ;; "test -r ${prodEnv}") echo 1 ;; "test -r ${staleCopy}") echo ${staleCopyReadable ? 0 : 1} ;; *) echo 1 ;; esac; }`;

  const patched = readFileSync(PROOF, "utf8")
    .replaceAll("/etc/systemd/system/", `${dir}/unitdir/`)
    .replaceAll("/home/shoslot/pr9", slot)
    .replaceAll("/home/deploy", `${dir}/deploy`)
    .replaceAll("/etc/sho", shoDir)
    .replaceAll("/proc/", `${dir}/proc/`)
    .replaceAll('$(id -u "$SLOT_ACCOUNT")', "9001")
    .replace(/^\[ "\$\(id -u\)" -eq 0 \].*$/m, '[ -n "$FAKE_ROOT" ] || fail "needs root"')
    .replace(/^\[ "\$\(uname -s\)" = 'Linux' \].*$/m, ":")
    .replace(/^id -u "\$SLOT_ACCOUNT".*$/m, ":")
    .replace(/^as_slot\(\).*$/m, () => asSlot);
  writeFileSync(join(dir, "proof.sh"), patched);

  const run = (...args) => {
    const res = spawnSync("bash", [join(dir, "proof.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_ROOT: "1" },
    });
    for (const p of pids) { try { process.kill(Number(p)); } catch { /* already gone is fine */ } }
    return res;
  };
  return { dir, run };
}

const verdict = (stdout) => /^CONTAINMENT=(PASS|FAIL)\b/m.exec(stdout)?.[1] ?? "(no CONTAINMENT line)";
// The verdict is cumulative: `containment_terms_failed=` is the pre-start answer, `proof_terms_failed=` the
// run's own. A full run prints both, so read EVERY term line and join them - a helper that took only the first
// would report the pre-start answer and hide a post-start term (measured: it hid listen_on_3109_count).
const failedTerms = (stdout) => {
  const all = [...stdout.matchAll(/^(?:containment|proof)_terms_failed=(.*)$/gm)].map((m) => m[1].trim());
  return all.length ? all.join(",") : "(no terms line)";
};



// ---------------------------------------------------------------------------
// 1. SSH persistence: a denial over a file that does not exist is not a measurement.
// ---------------------------------------------------------------------------
test("no authorized_keys to write: the pre-start gate must not PASS on an unmeasured SSH control", () => {
  const res = build({ authKeys: false, running: false }).run("--pre-start");
  assert.equal(res.status, 1, [
    "an absent authorized_keys made the SSH-persistence denial vacuous, and the gate still authorised a start:",
    res.stdout, res.stderr,
  ].join("\n"));
  assert.equal(verdict(res.stdout), "FAIL", res.stdout);
  assert.doesNotMatch(res.stdout, /^CONTAINMENT=PASS\b/m);
  assert.match(failedTerms(res.stdout), /authorized_keys/, "the FAIL must name the control that was not measured");
});

test("no authorized_keys to write: the full run must not print PROOF=PASS either", () => {
  const res = build({ authKeys: false }).run();
  assert.equal(res.status, 1, `PROOF=PASS was printed over an unmeasured SSH control:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /^PROOF=PASS\b/m);
});

// ---------------------------------------------------------------------------
// 2. The listener count is printed with an "expect" and read by no term.

// ---------------------------------------------------------------------------
// 3. A stale copy the glob does not match is never probed: the slot CAN read the production env and the
//    gate still passes. This is C1's hole, not C2's: the slot is not contained, and PRESTART=PASS says it is.
// ---------------------------------------------------------------------------
test("a readable stale copy named app.env.old is neither counted nor probed, so the gate passes anyway", () => {
  const res = build({ running: false, staleCopyReadable: true }).run("--pre-start");
  assert.equal(res.status, 1, [
    "the slot could read a stale production env and the pre-start gate authorised the start:",
    res.stdout, res.stderr,
  ].join("\n"));
  assert.match(failedTerms(res.stdout), /stale|bak/, "the FAIL must name the probe that did not cover the copy");
// OPEN ON THIS TREE, and deliberately not repaired here: closing it means deciding which copies of the
// production env count (the glob `app.env.bak*`, the one hard-coded probe path, or every file in /etc/sho that
// parses as an env). That is a policy the containment owner has to set, not a one-line fix, so it is reported
// as finding F1 in W102-REPORT.md and this test is this packet's ONE deliberate red: it goes green when the
// policy lands, not before. (Node 24 does not suppress a failing `{ todo }` test's exit code, so marking it
// todo would have looked green in the count and red in the run - it is left plainly red instead.)
});

// ---------------------------------------------------------------------------
test("a listener count of 0 (ss absent) violates the line's own expect >=1 and must fail the proof", () => {
  const res = build({ ssListens: false }).run();
  assert.match(res.stdout, /^listen_on_3109_count=0\b/m, "the sandbox must reproduce the printed 0");
  assert.equal(res.status, 1, [
    "the run printed listen_on_3109_count=0 against its own (expect >=1) and still reached a verdict:",
    res.stdout, res.stderr,
  ].join("\n"));
  assert.doesNotMatch(res.stdout, /^PROOF=PASS\b/m);
  assert.match(failedTerms(res.stdout), /listen_on_3109_count/);
});

// ---------------------------------------------------------------------------
// 3. The harness is not failing everything: the clean sandbox must still pass both gates.
// ---------------------------------------------------------------------------
test("the clean sandbox still PASSES both gates (the two probes above are the only difference)", () => {
  const gate = build({ running: false }).run("--pre-start");
  assert.equal(gate.status, 0, `${gate.stdout}\n${gate.stderr}`);
  assert.match(gate.stdout, /^CONTAINMENT=PASS\b/m);
  const full = build().run();
  assert.equal(full.status, 0, `${full.stdout}\n${full.stderr}`);
  assert.match(full.stdout, /^PROOF=PASS\b/m);
});
