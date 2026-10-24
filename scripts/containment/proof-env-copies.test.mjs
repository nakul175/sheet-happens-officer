// CONTAINMENT (slot 9) — the ENV-COPY POLICY, pinned in both directions.
//
// W102 F1 was that slot9-proof.sh counted stale copies with one glob (`app.env.bak*`) and probed one
// hard-coded path, so `app.env.old` / `release.env.2026` / `app.env.save` were invisible to both and a slot
// that could read one still printed CONTAINMENT=PASS. proof-vacuity.test.mjs owns that receipt
// (`app.env.old`). This file owns the OTHER half of the fix, which that one receipt cannot state:
//
//   * the suffix is irrelevant — a copy named after `release.env` with a `.2026` suffix must fail the gate
//     just as a `.bak-…` one does;
//   * the policy does NOT flag files that are not env-shaped. A term that fires on `README.md`, a `.pem`, or
//     a world-readable `app.env.example` is a gate nobody can pass, and that is not a fix. So the same
//     sandbox with those files READABLE BY THE SLOT must still pass.
//
// Offline and macOS-safe, the same technique as the rest of the tier: copy the real script, redirect its
// host paths into a temp dir, answer systemctl/pgrep from proof-sandbox.mjs. No host, no root, no /etc/sho.
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
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

// `files` are extra entries written into the /etc/sho stand-in (name -> body).
// `readable` names the basenames the slot's `test -r` SUCCEEDS on; every other read is denied. The live
// app.env is denied unless `prodEnvReadable`, so an unrelated failure cannot explain the assertions.
function build({ files = {}, readable = [], prodEnvReadable = false, running = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-envcopies-"));
  for (const sub of ["slot/env", "slot/current", "sho", "deploy/.ssh", "lib", "unitdir", "bin", "proc"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  const shoDir = join(dir, "sho");
  writeFileSync(join(shoDir, "app.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(shoDir, BAK), "NODE_ENV=production\n");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(shoDir, name)), { recursive: true });
    writeFileSync(join(shoDir, name), body);
  }
  writeFileSync(join(dir, "deploy", ".ssh", "authorized_keys"), "ssh-ed25519 AAAA sandbox\n");
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
    return res;
  };
  return { run };
}

const failedTerms = (stdout) => {
  const all = [...stdout.matchAll(/^(?:containment|proof)_terms_failed=(.*)$/gm)].map((m) => m[1].trim());
  return all.length ? all.join(",") : "(no terms line)";
};


// ---------------------------------------------------------------------------
// 1. The suffix is not the question: a copy under an unrelated name is a copy.
// ---------------------------------------------------------------------------
test("a readable release.env.2026 fails the pre-start gate, though no glob for it ever existed", () => {
  const res = build({ files: { "release.env.2026": "NODE_ENV=production\n" }, readable: ["release.env.2026"] }).run("--pre-start");
  assert.equal(res.status, 1, `a readable production env copy was authorised:\n${res.stdout}\n${res.stderr}`);
  assert.match(failedTerms(res.stdout), /shoslot_can_read_stale_copy/, res.stdout);
  // Counted AND named, so the transcript says which copy was measured - not "0 of 0".
  assert.match(res.stdout, /prod_env_stale_count=2\b/, res.stdout);
  assert.match(res.stdout, /names=app\.env\.bak-20261019-115253,release\.env\.2026/, res.stdout);
  assert.doesNotMatch(res.stdout, /^CONTAINMENT=PASS\b/m);
});

test("a readable app.env.save fails the full proof as well, not only the pre-start gate", () => {
  const res = build({ files: { "app.env.save": "NODE_ENV=production\n" }, readable: ["app.env.save"], running: true }).run();
  assert.equal(res.status, 1, `the full run passed over a readable copy:\n${res.stdout}\n${res.stderr}`);
  assert.match(failedTerms(res.stdout), /shoslot_can_read_stale_copy/, res.stdout);
  assert.doesNotMatch(res.stdout, /^PROOF=PASS\b/m);
});

test("a readable copy one directory down is a copy too: top-level-only scanning was the same blind spot", () => {
  const res = build({
    files: { "backups/app.env.old": "NODE_ENV=production\n" },
    readable: ["backups/app.env.old"],
  }).run("--pre-start");
  assert.equal(res.status, 1, `a copy below the top level was not probed:\n${res.stdout}\n${res.stderr}`);
  assert.match(failedTerms(res.stdout), /shoslot_can_read_stale_copy/, res.stdout);
  assert.match(res.stdout, /prod_env_stale_count=2\b/, res.stdout);
});

// ---------------------------------------------------------------------------
// 2. AND THE OTHER DIRECTION: a file that is not an env copy must not fail the gate, however it is named
//    and even when the slot can read it. `app.env.example` is the sharp case: it starts with the live name.
// ---------------------------------------------------------------------------
test("non-env files and template names cannot fail the gate: README, a key, .env.example all readable", () => {
  const res = build({
    files: {
      "README.md": "notes\n",
      "server.pem": "-----BEGIN-----\n",
      "app.env.example": "DATABASE_URL=postgres://user:pass@host/db\n",
      "db.env.sample": "DATABASE_URL=\n",
    },
    readable: ["README.md", "server.pem", "app.env.example", "db.env.sample"],
  }).run("--pre-start");
  assert.equal(res.status, 0, [
    "the policy flagged a non-env file, which is a gate nobody can pass:", res.stdout, res.stderr,
  ].join("\n"));
  assert.match(res.stdout, /^CONTAINMENT=PASS\b/m);
  // Only the .bak copy is counted: the live app.env is the OTHER term's job, and the four files above are
  // not copies. The count is asserted so "not flagged" cannot quietly become "not seen at all".
  assert.match(res.stdout, /prod_env_stale_count=1\b/, res.stdout);
  assert.match(res.stdout, /names=app\.env\.bak-20261019-115253\b/, res.stdout);
});

// The live env is not a "copy": it has its own EXISTS + DENIED pair. If it were counted here, the count
// would be nonzero on a host with no copies and would stop answering "how many copies are there".
test("the live app.env is excluded from the copy count but still fails on its own term", () => {
  const clean = build({ prodEnvReadable: false }).run("--pre-start");
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
  assert.match(clean.stdout, /prod_env_stale_count=1\b/, clean.stdout);
  assert.match(clean.stdout, /prod_env_stale_exists=1\b/, clean.stdout);

  const leaky = build({ prodEnvReadable: true }).run("--pre-start");
  assert.equal(leaky.status, 1, `a readable live prod env must fail:\n${leaky.stdout}`);
  assert.doesNotMatch(leaky.stdout, /^CONTAINMENT=PASS\b/m);
  // It must fail on ITS OWN question: the copy term is not a stand-in for the live env. (The live-env
  // denial sets the gap directly rather than naming a term - pre-existing, and deliberately unchanged here.)
  assert.doesNotMatch(failedTerms(leaky.stdout), /stale|bak/, "the live env must fail on ITS term, not the copy term");
});

