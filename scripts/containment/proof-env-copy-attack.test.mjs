// CONTAINMENT (slot 9) — W119, INDEPENDENT RE-REVIEW of W102 F1 (env-copy policy).
//
// W118 replaced `find -name 'app.env.bak*'` + one hard-coded probe path with an enumeration over the name set
// `app.env* / release.env* / *.env / *.env.* / *.env-* / *.env~` under /etc/sho, counting and probing every hit.
// This file does NOT re-run W118's own receipts (proof-env-copies.test.mjs). It attacks the POLICY from the
// outside, with names and shapes the policy's wording covers but its `find` expression may not reach:
//
//   * names with a suffix the expression never spells (`app.env.old`, `release.env.2026`, `app.env.save`);
//   * a dotfile (`.env.production`), a copy in a SUBDIRECTORY, a symlink to a copy outside the tree, and a
//     symlink to a DIRECTORY outside the tree (the shape `find` does not descend into by default);
//   * a copy that is group-readable but not slot-readable (must PASS: the slot is the uid the claim is about);
//   * a copy that exists but cannot be read at all (must PASS *with* EXISTS measured: a denial over a path that
//     is not there proves nothing);
//   * and the opposite failure: a legitimate /etc/sho (README, a key, a template `.env.example`, a `tls/`
//     subdirectory) must still PASS, or the gate is one nobody can pass.
//
// Offline and macOS-safe, the same technique as the rest of the tier: copy the real script, redirect its host
// paths into a temp dir, answer systemctl/pgrep from proof-sandbox.mjs. No host, no root, no /etc/sho.
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containmentLines, pgrepBody, systemctlBody } from "./proof-sandbox.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PROOF = join(here, "slot9-proof.sh");
const LIB = join(here, "lib", "unit-env-sources.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");
const MARKERS = "defaultdb|doadmin|25061|sho-prod-pool";
const BAK = "app.env.bak-20261019-115253";
const PROD_BODY = "DATABASE_URL=postgres://prod@db:5432/sho_prod\n";

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

// `files` entries, relative to the /etc/sho stand-in:
//   { path, body }        a regular file
//   { path, body, mode }  a regular file with that mode (0o640, 0o000, ...)
//   { path, dir: true }   a directory
//   { path, linkTo }      a symlink; `linkTo` is a path as find would see it, or "outside:<name>" for a target
//                         in the sandbox's own out-of-tree directory
// `readable` names the sho-relative paths the slot's `test -r` SUCCEEDS on; every other read is denied, so a
// PASS cannot be explained by an unrelated denial. `as_slot` is stubbed with a boolean (exactly what the proof
// consumes) rather than chmod-modelled: the proof never reads a mode, it asks `test -r` as the slot.
function build({ files = [], readable = [], prodEnvReadable = false, running = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-envattack-"));
  for (const sub of ["slot/env", "slot/current", "sho", "deploy/.ssh", "lib", "unitdir", "bin", "proc", "outside"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  const shoDir = join(dir, "sho");
  const outside = (p) => join(dir, "outside", p);
  const locked = [];
  writeFileSync(join(shoDir, "app.env"), PROD_BODY);
  writeFileSync(join(shoDir, BAK), PROD_BODY);
  for (const entry of files) {
    const target = entry.outside ? outside(entry.path) : join(shoDir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      if (entry.mode !== undefined) locked.push([target, entry.mode]);
      continue;
    }
    if (entry.linkTo) {
      const dest = entry.linkTo.startsWith("outside:") ? outside(entry.linkTo.slice(8)) : entry.linkTo;
      if (entry.linkTo.startsWith("outside:")) mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(dest, target);
      continue;
    }
    writeFileSync(target, entry.body ?? PROD_BODY);
    if (entry.mode !== undefined) chmodSync(target, entry.mode);
  }
  writeFileSync(join(dir, "deploy", ".ssh", "authorized_keys"), "ssh-ed25519 AAAA sandbox\n");
  writeFileSync(join(slot, "env", "db.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(slot, "env", "app.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "env", "local.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "current", "release.env"), "PORT=3109\n");
  writeFileSync(join(dir, "unitdir", "sho-pr9.service"), unitText(slot, shoDir));
  // Modes that would prevent writing the directory's contents are applied last, on purpose, and lifted again
  // after each run so the sandbox stays removable.
  for (const [p, mode] of locked) chmodSync(p, mode);
  const restore = () => { for (const [p] of locked) chmodSync(p, 0o755); };

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
    writeFileSync(join(dir, "proc", pid, "environ"), "NODE_ENV=production\0PORT=3109\0");
  }
  const deploy = sleeper();

  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("systemctl", systemctlBody({ unitFile: join(dir, "unitdir", "sho-pr9.service"), mainPid: pid }));
  stub("ss", 'echo "LISTEN 0 511 127.0.0.1:3109 0.0.0.0:*"');
  stub("curl", `for a in "$@"; do [ "$a" = "-o" ] && { printf 200; exit 0; }; done\nprintf '{"ok":true,"release":"deadbeef"}'`);
  stub("pgrep", pgrepBody(deploy));

  const arms = ['"test -e /") echo 0 ;;'];
  if (prodEnvReadable) arms.push(`"test -r ${join(shoDir, "app.env")}") echo 0 ;;`);
  for (const name of readable) arms.push(`"test -r ${join(shoDir, name)}") echo 0 ;;`);
  const asSlot = `as_slot() { case "$*" in ${arms.join(" ")} *) echo 1 ;; esac; }`;

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
    restore();
    return res;
  };
  return { dir, shoDir, run };
}

const verdict = (stdout) => /^CONTAINMENT=(PASS|FAIL)\b/m.exec(stdout)?.[1] ?? "(no CONTAINMENT line)";
const staleLine = (stdout) => stdout.split("\n").find((l) => l.startsWith("prod_env_stale_count=")) ?? "(no stale line)";
const field = (stdout, key) => new RegExp(`\\b${key}=(\\d+)`).exec(staleLine(stdout))?.[1] ?? "(absent)";
const readableBySlot = (stdout) => /readable_by_slot=(\d+\/\d+)/.exec(staleLine(stdout))?.[1] ?? "(absent)";
const failedTerms = (stdout) => {
  const all = [...stdout.matchAll(/^(?:containment|proof)_terms_failed=(.*)$/gm)].map((m) => m[1].trim());
  return all.length ? all.join(",") : "(no terms line)";
};

// ---------------------------------------------------------------------------
// 1. THE RE-PROOF OF F1: a copy whose name has no `.bak` in it, readable by the slot, must fail the gate.
//    Every name here is one the policy's own words cover ("app.env plus any suffix", "release.env plus any
//    suffix", "any other *.env file with or without one").
// ---------------------------------------------------------------------------
test("every env-shaped name in the policy's words, readable by the slot, fails the gate", () => {
  const cases = [
    { name: "app.env.old", files: [{ path: "app.env.old" }], probe: "app.env.old" },
    { name: "release.env.2026", files: [{ path: "release.env.2026" }], probe: "release.env.2026" },
    { name: "app.env.save", files: [{ path: "app.env.save" }], probe: "app.env.save" },
    { name: "app.env~", files: [{ path: "app.env~" }], probe: "app.env~" },
    { name: ".env.production", files: [{ path: ".env.production" }], probe: ".env.production" },
    { name: "db.env", files: [{ path: "db.env" }], probe: "db.env" },
    { name: "backups/app.env.old (subdirectory)", files: [{ path: "backups/app.env.old" }], probe: "backups/app.env.old" },
    { name: "app.env.link -> file outside the tree", files: [
      { path: "copy.env", outside: true },
      { path: "app.env.link", linkTo: "outside:copy.env" },
    ], probe: "app.env.link" },
  ];
  const rows = [];
  const misses = [];
  for (const c of cases) {
    const res = build({ files: c.files, readable: [c.probe] }).run("--pre-start");
    const row = `${c.name} | count=${field(res.stdout, "prod_env_stale_count")} exists=${field(res.stdout, "prod_env_stale_exists")} readable=${readableBySlot(res.stdout)} | ${verdict(res.stdout)}`;
    rows.push(row);
    if (verdict(res.stdout) !== "FAIL") misses.push(row);
  }
  console.log(`\n[W119 attack matrix: env-shaped names]\n  ${rows.join("\n  ")}`);
  assert.deepEqual(misses, [], [
    "a name the policy's words cover was neither caught nor probed, so the slot read a production-env copy:",
    ...misses,
  ].join("\n"));
});

// ---------------------------------------------------------------------------
// 2. THE SHAPE `find` DOES NOT DESCEND INTO. The policy says "any regular file or symlink ANYWHERE under
//    /etc/sho". A symlinked directory is not itself env-shaped, and plain `find` does not walk into it, so
//    every env-named copy inside it is invisible to the count AND to the probe - the exact F1 failure mode,
//    reached through a directory link instead of a filename suffix.
// ---------------------------------------------------------------------------
test("a copy inside a symlinked directory under /etc/sho is counted and probed too", () => {
  const res = build({
    files: [
      { path: "envs/app.env.old", outside: true },
      { path: "previous", linkTo: "outside:envs" },
    ],
    readable: ["previous/app.env.old"],
  }).run("--pre-start");
  console.log(`\n[W119 attack matrix: symlinked directory]\n  previous -> <outside>/envs (readable) | ${staleLine(res.stdout)} | ${verdict(res.stdout)}`);
  assert.equal(res.status, 1, [
    "the slot could read /etc/sho/previous/app.env.old (a copy outside the tree, reachable by a path under /etc/sho),",
    "and the pre-start gate authorised the start. The policy's words cover it; the find expression does not reach it:",
    staleLine(res.stdout), `CONTAINMENT=${verdict(res.stdout)}`, res.stderr,
  ].join("\n"));
  assert.match(failedTerms(res.stdout), /shoslot_can_read_stale_copy|prod_env_stale/);
});

// ---------------------------------------------------------------------------
// 3. A denial over a path that is not there proves nothing, so EXISTS has to be measured for EVERY copy. A
//    copy that exists and cannot be read at all is contained: the term is "the slot cannot read a copy", not
//    "no copy may exist". So this must PASS *with* exists == count, not pass because nothing was found.
// ---------------------------------------------------------------------------
test("a copy that exists but cannot be read is contained, and EXISTS is measured rather than skipped", () => {
  const res = build({ files: [{ path: "app.env.old", mode: 0o000 }] }).run("--pre-start");
  assert.equal(verdict(res.stdout), "PASS", `${staleLine(res.stdout)}\n${res.stdout}`);
  assert.equal(field(res.stdout, "prod_env_stale_count"), "2", staleLine(res.stdout));
  assert.equal(field(res.stdout, "prod_env_stale_exists"), "2", [
    "the copy was not confirmed present, so its denial was measured against nothing:",
    staleLine(res.stdout),
  ].join("\n"));
  assert.match(readableBySlot(res.stdout), /^0\/2$/, staleLine(res.stdout));
});

test("a copy that is group-readable but not slot-readable does not fail the gate", () => {
  const res = build({ files: [{ path: "app.env.old", mode: 0o640 }] }).run("--pre-start");
  assert.equal(verdict(res.stdout), "PASS", `${staleLine(res.stdout)}\n${res.stdout}`);
  assert.equal(field(res.stdout, "prod_env_stale_count"), "2", staleLine(res.stdout));
  assert.match(readableBySlot(res.stdout), /^0\/2$/, staleLine(res.stdout));
});

// A symlink whose target is gone is the one shape where the enumeration and EXISTS can disagree: `find -type l`
// lists it, `[ -e ]` (which follows the link) says no. The header's rule makes a count without a confirmed
// existence a FAIL, and a dangling `.env` link is cheap for an operator to leave behind - so pin the answer.
test("a dangling env-named symlink cannot be counted as a denied copy without being confirmed present", () => {
  const res = build({ files: [{ path: "app.env.old", linkTo: "outside:gone.env" }] }).run("--pre-start");
  const counted = field(res.stdout, "prod_env_stale_count");
  const exists = field(res.stdout, "prod_env_stale_exists");
  console.log(`\n[W119 attack matrix: dangling symlink]\n  app.env.old -> <gone> | count=${counted} exists=${exists} | ${verdict(res.stdout)} | terms=${failedTerms(res.stdout)}`);
  if (counted !== exists) {
    assert.equal(verdict(res.stdout), "FAIL", [
      "a copy was counted but never confirmed present, and the gate still passed:",
      staleLine(res.stdout),
    ].join("\n"));
  }
});

// ---------------------------------------------------------------------------
// 5. AN UNRUN PROBE MUST FAIL, and the enumeration is a probe. If `find` cannot walk the directory (a
//    subdirectory it may not enter, an I/O error, a loop it cannot resolve) the count would be 0 for the wrong
//    reason - an unmeasured "no copies" - so the scan term has to answer 0 and the verdict has to FAIL. This is
//    the one case where a correct-but-unreadable directory is deliberately fatal: fail closed, by name.
// ---------------------------------------------------------------------------
test("an enumeration that cannot complete fails the scan term instead of reporting zero copies", () => {
  const res = build({
    files: [
      { path: "locked", dir: true, mode: 0o000 },
      { path: "locked/app.env.old" },
    ],
  }).run("--pre-start");
  const scan = field(res.stdout, "prod_env_stale_scan");
  console.log(`\n[W119 attack matrix: unreadable subdirectory]\n  locked/ (mode 000) | ${staleLine(res.stdout)} | ${verdict(res.stdout)} | terms=${failedTerms(res.stdout)}`);
  if (process.getuid?.() !== 0) {
    // As an unprivileged uid (the sandbox) find really cannot enter the directory, so the mechanism is measured.
    assert.equal(scan, "0", `the walk failed but the scan term still claimed success:\n${staleLine(res.stdout)}`);
    assert.equal(verdict(res.stdout), "FAIL", staleLine(res.stdout));
    assert.match(failedTerms(res.stdout), /prod_env_stale_scan/);
  }
});

// ---------------------------------------------------------------------------
// 6. THE RESIDUAL, MEASURED RATHER THAN LEFT TO ARGUMENT. A name-based gate cannot be complete: a copy called
//    `env` (no dot), `APP.ENV` (upper case), or `notes.txt` (a hard link) is not env-shaped by the policy's
//    own definition, so it is NOT counted and NOT probed. This test pins what actually happens, so the gap is
//    reported instead of being mistaken for coverage. Widening the name set is a policy decision with a real
//    cost (every added name is also a file a PASS can be denied over), so it is left to the containment owner.
// ---------------------------------------------------------------------------
test("names the policy does not cover are not counted, and that residual is recorded here", () => {
  const cases = [
    { name: "env (no dot)", files: [{ path: "env" }], probe: "env" },
    { name: "APP.ENV (upper case)", files: [{ path: "APP.ENV" }], probe: "APP.ENV" },
  ];
  const rows = [];
  for (const c of cases) {
    const res = build({ files: c.files, readable: [c.probe] }).run("--pre-start");
    rows.push(`${c.name} | count=${field(res.stdout, "prod_env_stale_count")} readable=${readableBySlot(res.stdout)} | ${verdict(res.stdout)}`);
  }
  console.log(`\n[W119 attack matrix: residual names outside the policy]\n  ${rows.join("\n  ")}`);
  // The named copy is the .bak one only: neither residual name was enumerated. A PASS here is the documented
  // residual, not a pass for the right reason.
  assert.ok(rows.every((r) => r.includes("count=1 ")), rows.join("\n"));
});

// ---------------------------------------------------------------------------
// 4. THE OPPOSITE FAILURE. A legitimate /etc/sho must PASS: docs, a key, a template, and a `tls/` subdirectory
//    the slot can read are not env copies. `app.env.example` is the sharp case - it starts with the live name.
// ---------------------------------------------------------------------------
test("a legitimate /etc/sho still PASSES even when every non-env file is readable by the slot", () => {
  const res = build({
    files: [
      { path: "README.md", body: "notes\n" },
      { path: "server.pem", body: "-----BEGIN-----\n" },
      { path: "app.env.example", body: "DATABASE_URL=postgres://user:pass@host/db\n" },
      { path: "db.env.sample", body: "DATABASE_URL=\n" },
      { path: "tls", dir: true },
      { path: "tls/server.pem", body: "-----BEGIN-----\n" },
    ],
    readable: ["README.md", "server.pem", "app.env.example", "db.env.sample", "tls/server.pem"],
  }).run("--pre-start");
  assert.equal(verdict(res.stdout), "PASS", [
    "the policy flagged a file that is not an env copy, which is a gate nobody can pass:",
    staleLine(res.stdout), res.stdout, res.stderr,
  ].join("\n"));
  assert.equal(field(res.stdout, "prod_env_stale_count"), "1", staleLine(res.stdout));
});
