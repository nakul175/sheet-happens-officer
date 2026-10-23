// CONTAINMENT (slot 9) — the EnvironmentFile enumeration, attacked.
//
// The packet's question: can the proof print `unit_envfile_count=4 … env_guard=4` (and `gap_closed=1`)
// while a source is outside the slot tree, unguarded, or unreadable? These tests answer it by running the
// real scripts against a sandbox unit file: nothing here touches the staging host, root, systemd, sudoers
// or any real env file, and no env VALUE is written into any fixture.
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync,
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

const MARKERS = 'defaultdb|doadmin|25061|sho-prod-pool';

// The five-source shape. `fifth` is the path under attack; `guarded` names the source indices that carry
// an ExecStartPre guard line, so "appended after rendering, without a guard" is expressible.
function unitText({ slot, fifth, guarded = [0, 1, 2, 3] }) {
  const sources = [
    `${slot}/env/db.env`,
    `${slot}/env/app.env`,
    `${slot}/env/local.env`,
    `${slot}/current/release.env`,
  ];
  if (fifth) sources.push(fifth);
  const lines = ["[Unit]", "Description=sandbox", "", "[Service]"];
  // The rendered unit's own mix: db/app are mandatory, local/release are `-` (absent is allowed). The
  // appended fifth is `-` too, which is what makes an absent-but-outside path survive a start.
  sources.forEach((p, i) => lines.push(`EnvironmentFile=${i < 2 ? "" : "-"}${p}`));
  sources.forEach((p, i) => {
    if (!guarded.includes(i)) return;
    lines.push(`ExecStartPre=/bin/sh -c 'test ! -e ${p} || { test -r ${p} && ! grep -qEi -- "${MARKERS}" ${p}; }'`);
  });
  return `${lines.join("\n")}\n`;
}

function libRun(unitFile, roots) {
  return spawnSync("bash", ["-c", `source "${LIB}"; unit_env_sources "$@"`, "bash", unitFile, ...roots], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

function counts(stdout) {
  const out = {};
  for (const line of stdout.split("\n")) {
    const m = /^UNIT_(ENV[A-Z_]*)=(\d+)$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function sandbox(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-envsources-"));
  for (const sub of ["slot/env", "slot/current", "evil", "outside", "lib"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  writeFileSync(join(slot, "env", "db.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(slot, "env", "app.env"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "outside", "release.env"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "evil", "extra.env"), "NODE_ENV=production\n");
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  const writeUnit = (text, name = "unit") => {
    const p = join(dir, `${name}.service`);
    writeFileSync(p, text);
    return p;
  };
  return { dir, slot, writeUnit, roots: [`${slot}/env`, `${slot}/current`] };
}

// ---------------------------------------------------------------------------
// 1. The lib, called directly. This is the enumeration BOTH scripts now use.
// ---------------------------------------------------------------------------
test("lib: a correct four-source unit is clean on every counter", () => {
  const s = sandbox();
  const unit = s.writeUnit(unitText({ slot: s.slot }));
  const res = libRun(unit, s.roots);
  assert.equal(res.status, 0, res.stderr);
  const c = counts(res.stdout);
  assert.deepEqual(
    { count: c.ENVFILE_COUNT, outside: c.ENV_OUTSIDE, unguarded: c.ENV_UNGUARDED, prod: c.ENV_PROD, guard: c.ENV_GUARD },
    { count: 4, outside: 0, unguarded: 0, prod: 0, guard: 4 },
    res.stdout,
  );
});

test("lib: a fifth source that escapes the tree with `..` is OUTSIDE, and is seen even when unguarded", () => {
  const s = sandbox();
  // `slot/env/../../evil/extra.env` is the exact shape the old `case …/slot/env/*` glob called "inside".
  const fifth = `${s.slot}/env/../../evil/extra.env`;
  const unit = s.writeUnit(unitText({ slot: s.slot, fifth }));
  const res = libRun(unit, s.roots);
  const c = counts(res.stdout);
  assert.equal(c.ENVFILE_COUNT, 5, res.stdout);
  assert.equal(c.ENV_OUTSIDE, 1, `a path that leaves the slot tree must be outside: ${res.stdout}`);
  assert.equal(c.ENV_UNGUARDED, 1, `an appended source has no ExecStartPre guard: ${res.stdout}`);
});

test("lib: a sibling-prefix path is not under the slot tree", () => {
  const s = sandbox();
  // /…/pr9x is not under /…/pr9 even though it starts with the same bytes.
  const unit = s.writeUnit(unitText({ slot: s.slot, fifth: `${s.slot}x/env/db.env`, guarded: [0, 1, 2, 3, 4] }));
  const c = counts(libRun(unit, s.roots).stdout);
  assert.equal(c.ENV_OUTSIDE, 1, "a bare prefix match must not count as containment");
});

test("lib: a source that is a symlink out of the slot tree is OUTSIDE even with no marker in it", () => {
  const s = sandbox();
  symlinkSync(join(s.dir, "outside", "release.env"), join(s.slot, "current", "release.env"));
  const unit = s.writeUnit(unitText({ slot: s.slot }));
  const c = counts(libRun(unit, s.roots).stdout);
  assert.equal(c.ENV_OUTSIDE, 1, "release.env resolving outside the slot tree is not a slot source");
  assert.equal(c.ENV_PROD, 0, "no marker is involved: the escape, not the marker, is what must be caught");
});

test("lib: an existing source with a marker is a hit, and no value or path is printed", () => {
  const s = sandbox();
  writeFileSync(join(s.slot, "env", "app.env"), "DATABASE_URL=postgres://doadmin@db:25061/defaultdb\n");
  const unit = s.writeUnit(unitText({ slot: s.slot }));
  const res = libRun(unit, s.roots);
  assert.equal(counts(res.stdout).ENV_PROD, 1, res.stdout);
  assert.doesNotMatch(res.stdout + res.stderr, /doadmin|25061|defaultdb/, "counts only, never the matched text");
  assert.doesNotMatch(res.stdout, /\.env/, "counts only, never a source path");
});

test("lib: refuses to answer (exit 2) when the unit file is not there", () => {
  const s = sandbox();
  const res = libRun(join(s.dir, "nope.service"), s.roots);
  assert.equal(res.status, 2, "an unreadable unit must not look like a unit with zero sources");
  assert.match(res.stderr, /usage/);
});

// ---------------------------------------------------------------------------
// 2. The proof itself, against a sandbox unit file. The script is copied and its host paths and its root
// / systemd preconditions are redirected into a temp dir — the same technique the rollback test uses, so
// what runs here is the real P4 code and verdict, not a re-implementation of it.
// ---------------------------------------------------------------------------
function proofRun({ fifth, guarded, releaseLink, slotCanReadProdEnv = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-proof-"));
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
  if (releaseLink) symlinkSync(join(dir, "outside", "release.env"), join(slot, "current", "release.env"));
  writeFileSync(join(dir, "unitdir", "sho-pr9.service"), unitText({ slot, fifth: fifth?.(slot), guarded }));

  // A live process this test owns, so the P2 environ reads are truthfully readable and key-bearing. macOS
  // has no /proc, so the proof's /proc reads are pointed at a sandbox stand-in with real NUL separators.
  const sleeper = spawnSync("bash", ["-c", "sleep 20 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const pid = sleeper.stdout.trim();
  mkdirSync(join(dir, "proc", pid), { recursive: true });
  writeFileSync(join(dir, "proc", pid, "environ"), "NODE_ENV=production\0DATABASE_URL=postgres://sho@127.0.0.1:5432/x\0");
  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("systemctl", `for a in "$@"; do [ "$a" = "MainPID" ] && { echo ${pid}; exit 0; }; done\nexit 0`);
  stub("ss", `echo "LISTEN 0 511 127.0.0.1:3109 0.0.0.0:*"`);
  stub("curl", `for a in "$@"; do [ "$a" = "-o" ] && { printf 200; exit 0; }; done\nprintf '{"ok":true,"release":"deadbeef"}'`);
  stub("pgrep", "exit 1");

  // as_slot's contract: it echoes 0 when the probe SUCCEEDS (the slot could do it) and 1 when it is
  // denied — the same contract the script's positive control depends on. `slotCanReadProdEnv` models the
  // host where containment is broken, so the verdict can be tested in both directions.
  const asSlot = slotCanReadProdEnv
    ? 'as_slot() { case "$*" in "test -e /") echo 0 ;; "test -r ' + join(dir, "sho", "app.env") + '") echo 0 ;; *) echo 1 ;; esac; }'
    : 'as_slot() { case "$*" in "test -e /") echo 0 ;; *) echo 1 ;; esac; }';

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
    // Harness artifact, not a script defect: macOS ships bash 3.2, which cannot parse `case … esac` inside
    // a command substitution in a double-quoted string (measured here; bash 5 on the staging host parses
    // it). These two P5 lines are informational and feed no verdict term, so the sandbox drops them.
    .replace(/^say "dsn_is_loopback=.*$/m, ": # bash 3.2 parse artifact (harness only)")
    .replace(/^say "dsn_port_5432=.*$/m, ": # bash 3.2 parse artifact (harness only)");
  writeFileSync(join(dir, "proof.sh"), patched);
  const res = spawnSync("bash", [join(dir, "proof.sh")], {
    encoding: "utf8",
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_ROOT: "1" },
  });
  try { process.kill(Number(pid)); } catch { /* the test's own sleeper; already gone is fine */ }
  return { ...res, slot, dir };
}

const p4 = (stdout) => stdout.split("\n").find((l) => l.startsWith("unit_envfile_count=")) ?? "(no P4 line)";
const gap = (stdout) => /^gap_closed=(\d)$/m.exec(stdout)?.[1] ?? "(no verdict)";


test("proof: a clean sandbox unit still PASSES (the harness is not failing everything)", () => {
  const res = proofRun();
  assert.match(res.stdout, /probe_positive_control=1/, res.stderr);
  assert.equal(gap(res.stdout), "1", `${p4(res.stdout)}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /PROOF=PASS/);
});

test("proof: a slot that CAN read the production env must not yield PASS (the verdict is not inverted)", () => {
  // as_slot echoes 0 = "the slot could do it", 1 = denied. The three P1 terms compared `-eq 1`, so a host
  // where shoslot CAN read /etc/sho/app.env — the exact condition this whole block exists to disprove —
  // printed gap_closed=1 PROOF=PASS, and a correct host never passed at all.
  const broken = proofRun({ slotCanReadProdEnv: true });
  assert.equal(gap(broken.stdout), "0", `an open gap was reported closed:\n${broken.stdout}`);
  assert.doesNotMatch(broken.stdout, /PROOF=PASS/);
  const held = proofRun();
  assert.equal(gap(held.stdout), "1", `a closed gap was reported open:\n${p4(held.stdout)}`);
  assert.match(held.stdout, /shoslot_can_read_prod_env=1/, "P1 must show the denial it is relying on");
});

test("proof: a fifth source that escapes the slot tree with `..` must not yield PASS", () => {
  const res = proofRun({ fifth: (slot) => `${slot}/env/../../evil/extra.env` });
  // What the OLD enumeration printed is in the message: count 5, outside 0, guard 4.
  assert.equal(gap(res.stdout), "0", `the escaping source was accepted:\n${p4(res.stdout)}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /PROOF=PASS/);
});

test("proof: a source that is a symlink out of the slot tree must not yield PASS", () => {
  const res = proofRun({ releaseLink: true });
  assert.equal(gap(res.stdout), "0", `a source resolving outside the slot tree was accepted:\n${p4(res.stdout)}`);
  assert.doesNotMatch(res.stdout, /PROOF=PASS/);
});

test("proof: a fifth source with no ExecStartPre guard must not yield PASS", () => {
  // Inside the tree and marker-free, so nothing but guard parity can catch it.
  const res = proofRun({ fifth: (slot) => `${slot}/env/extra.env` });
  assert.equal(gap(res.stdout), "0", `an unguarded source passed:\n${p4(res.stdout)}`);
  assert.doesNotMatch(res.stdout, /PROOF=PASS/);
});

// Design limit, recorded rather than hidden: the guards are `grep -qEi`, which is line-based. A marker
// split across a backslash continuation is invisible to them. systemd's EnvironmentFile continuation
// behaviour differs by version, so this is pinned as TODO until it is measured on the staging host — a
// guard that cannot be shown to catch it must not be described as catching it.
test(
  "guard: a marker split by a backslash continuation is not seen by the ExecStartPre guard",
  { todo: "systemd EnvironmentFile continuation semantics are unmeasured here" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "sho-split-"));
    const clean = join(dir, "clean.env");
    writeFileSync(clean, "NODE_ENV=production\n");
    const split = join(dir, "split.env");
    writeFileSync(split, "DATABASE_URL=postgres://u:p@db:2506\\\n1/defaultdb\n");
    const guardFor = (f) =>
      spawnSync("sh", ["-c", `test ! -e "${f}" || { test -r "${f}" && ! grep -qEi -- "${MARKERS}" "${f}"; }`]);
    assert.equal(guardFor(clean).status, 0, "the guard form itself passes a clean file");
    assert.notEqual(guardFor(split).status, 0, "a continued marker is not matched by the line-based guard");
  },
);

