// CONTAINMENT (slot 9, Option R). These tests are static/behavioural: nothing here runs on the staging host,
// needs root, or reads a real env file. They exist so the two runbook scripts cannot silently lose the property
// that makes them safe to run blind:
//   1. they refuse to act when a precondition fails (fail-closed, not "print ABORT and continue"),
//   2. they never print a value from an env file (booleans, counts and uid only),
//   3. re-running them does not break a good state.
// Evidence for every name/port/path asserted here is OS-IDENTITY-ISOLATION.md, cited in the scripts themselves.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const OPTION_R = join(here, "slot9-optionR.sh");
const PROOF = join(here, "slot9-proof.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");

const read = (path) => readFileSync(path, "utf8");

// A deliberately bare environment: these scripts must not depend on the caller's shell for anything.
function run(file, args = []) {
  return spawnSync("bash", [file, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

test("both runbook scripts exist and parse", () => {
  for (const file of [OPTION_R, PROOF, SCAN]) {
    const res = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(res.status, 0, `${file} does not parse: ${res.stderr}`);
  }
});

test("both runbook scripts are strict-mode", () => {
  for (const file of [OPTION_R, PROOF]) {
    assert.match(read(file), /^set -euo pipefail$/m, `${file} must set -euo pipefail`);
  }
});

// The gap that made the original §5 block unsafe: it echoed ABORT and walked on into R4/R6, so a slot with a
// production marker in its env would still be installed and started. Refusing must be a process exit.
test("optionR refuses to run as a non-root user, and does nothing else", () => {
  const res = run(OPTION_R);
  assert.notEqual(res.status, 0, "a non-root run must fail");
  assert.match(res.stderr, /refus|must be run as root/i);
  assert.doesNotMatch(res.stdout, /^R[1-6] /m, "no step may run after the refusal");
});

test("proof refuses to run as a non-root user", () => {
  const res = run(PROOF);
  assert.notEqual(res.status, 0, "a non-root run must fail");
  assert.match(res.stderr, /refus|must be run as root/i);
});

test("optionR --check plans without root, and defers what it cannot verify", () => {
  const res = run(OPTION_R, ["--check"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^PLAN$/m);
  // Names taken from OS-IDENTITY-ISOLATION.md §5 (unit) and §5.1/§6 (port), not invented here.
  assert.match(res.stdout, /\/etc\/systemd\/system\/sho-pr9\.service/);
  assert.match(res.stdout, /127\.0\.0\.1:3109/);
  assert.match(res.stdout, /InaccessiblePaths=\/etc\/sho/);
  assert.match(res.stdout, /DEFERRED/, "--check must say which preconditions it cannot check off-host");
});


// The rule from the packet and from §6's redaction rule: booleans and counts only.
test("neither script can print an env value", () => {
  const banned = [
    [/\bcat\b[^\n]*\/etc\/sho/, "cat of /etc/sho"],
    [/\bcat\b[^\n]*\/proc\/[^\n]*environ/, "cat of /proc/<pid>/environ"],
    [/\bprintenv\b/, "printenv"],
    [/^\s*set -[a-z]*x[a-z]*\s*$/m, "set -x (traces values)"],
  ];
  for (const file of [OPTION_R, PROOF]) {
    // Comments are excluded: they cannot leak anything, and the reason this rule exists is best explained
    // by naming the unsafe §6 command in prose.
    const body = read(file)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const [pattern, what] of banned) {
      assert.doesNotMatch(body, pattern, `${file} must not use ${what}`);
    }
  }
});

test("proof asserts the gap with booleans, and takes release identity from /api/health", () => {
  const body = read(PROOF);
  assert.match(body, /test -r/, "the read attempt must be test -r, never cat");
  assert.match(body, /grep -c/, "marker scans must be counts");
  assert.match(body, /shoslot_can_read_prod_env/, "P1 must state the gap as a named boolean");
  // src/app/api/health/route.ts:10 returns `release: process.env.RELEASE` — the release SHA proof, no secret read.
  assert.match(body, /api\/health/, "release identity comes from the health route");
});

function scanDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "sho-marker-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("the marker scanner counts staging-only env as clean", () => {
  const dir = scanDir({ "db.env": "DATABASE_URL=postgres://sho_slot_pr9_app@127.0.0.1:5432/sho_staging\n" });
  const res = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^PROD_MARKER_COUNT=0$/m);
  assert.match(res.stdout, /^ENV_CLEAN$/m);
});

test("the marker scanner fails the gate on a production marker and never echoes it", () => {
  const dir = scanDir({
    "db.env": "DATABASE_URL=postgres://doadmin@db:25061/defaultdb\n",
    "app.env": "PORT=3109\n",
  });
  const res = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
  assert.notEqual(res.status, 0, "a marker must make the scan exit non-zero so callers can stop");
  assert.match(res.stdout, /^PROD_MARKER_COUNT=1$/m);
  assert.doesNotMatch(res.stdout + res.stderr, /doadmin|25061|defaultdb/, "the scanner must not print matched text");
});

test("the marker scanner treats an empty directory as clean but distinguishable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sho-marker-empty-"));
  const res = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^PROD_MARKER_COUNT=0$/m);
  assert.match(res.stdout, /^ENV_FILE_COUNT=0$/m, "an empty env dir must not look like a pass");
});

test("optionR keeps a rollback that restores the stopped state", () => {
  const body = read(OPTION_R);
  assert.match(body, /--rollback/);
  assert.match(body, /disable --now "?\$\{?UNIT_NAME\}?"?/, "rollback must stop the unit");
  assert.match(body, /userdel "\$ACCOUNT"/, "rollback must remove the account it created");
  assert.match(body, /^readonly UNIT_NAME='sho-pr9'$/m, "the unit is sho-pr9, not a variable to be trusted");
  // Rollback must not touch the production unit or the DB role; it is pr9 + one account.
  assert.doesNotMatch(body, /systemctl[^\n]*\bsho\.service\b/);
});

test("optionR does not clobber an existing slot env on a re-run", () => {
  assert.match(read(OPTION_R), /--refresh-env/, "overwriting live slot env needs an explicit flag");
});

// ---------------------------------------------------------------------------
// Red-team regressions. Each of these FAILS on the code as it was committed
// (118955f), and passes after the fixes it names.
// ---------------------------------------------------------------------------

// The marker gate on the slot env. `exit 3` at :256 was correct in the committed code but NOTHING
// tested it: deleting that line (leaving the REFUSING text and the message that says nothing was
// installed) kept all 12 tests green, and the script happily walked into R4/R6. Order matters —
// the exit has to be between the scan result and the first R4 write.
test("the R3 marker gate is a process exit before R4, not a warning that continues", () => {
  const body = read(OPTION_R);
  const gateStart = body.indexOf('[ "$scan_rc" -ne 0 ]');
  const r4Start = body.indexOf('say "R4 unit"');
  assert.ok(gateStart > 0, "the R3 gate disappeared entirely");
  assert.ok(r4Start > gateStart, "R4 must come after the gate");
  const gate = body.slice(gateStart, r4Start);
  assert.match(gate, /^\s*exit 3\s*$/m, "the gate must exit 3 before any R4 write");
  assert.doesNotMatch(gate, /^\s*:\s*(#.*)?$/m, "the gate must not be a no-op");
});

// The slot env dir is writable by the account the slot runs as, so `db.env` can be a symlink to a
// production file. `find -type f` skipped it and `grep -r` does not follow a link found while
// walking, so the scan said ENV_CLEAN / exit 0 for a dir whose only file was a prod env. Measured
// with a real symlink before the fix.
test("the marker scanner follows a symlinked env file instead of reporting the dir clean", () => {
  // The link target lives OUTSIDE the scanned dir, which is the only shape that evaded the scan:
  // with the target also inside, `find -type f` counts it and the hole hides.
  const outside = mkdtempSync(join(tmpdir(), "sho-marker-target-"));
  writeFileSync(join(outside, "prod-real.env"), "DATABASE_URL=postgres://doadmin@db:25061/defaultdb\n");
  const dir = mkdtempSync(join(tmpdir(), "sho-marker-link-"));
  symlinkSync(join(outside, "prod-real.env"), join(dir, "db.env"));
  const res = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
  assert.notEqual(res.status, 0, "a symlink to a prod env must not scan clean");
  assert.match(res.stdout, /^PROD_MARKER_COUNT=1$/m);
  assert.match(res.stdout, /^ENV_CONTAMINATED$/m);
});

// A DSN pasted in upper case scanned clean: `grep -E` is case-sensitive and the marker list is not.
test("the marker scanner is not fooled by the case of a marker", () => {
  const dir = scanDir({ "db.env": "DATABASE_URL=postgres://DOADMIN:pw@db.example.com:5432/MAIN\n" });
  const res = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
  assert.notEqual(res.status, 0, "DOADMIN is the same credential as doadmin");
  assert.match(res.stdout, /^ENV_CONTAMINATED$/m);
});

// The marker scanner must be able to scan an explicit FILE, not only a directory. The unit loads four
// EnvironmentFile sources; the fourth, current/release.env, is created by phase 2 AFTER R4, so it cannot
// be covered by a scan of the env dir. Scanning 3 of 4 sources is the gap this pins shut.
test("the marker scanner scans an explicit env file, including through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "sho-marker-file-"));
  writeFileSync(join(dir, "release.env"), "DATABASE_URL=postgres://doadmin@db:25061/defaultdb\n");
  const direct = spawnSync("bash", [SCAN, join(dir, "release.env")], { encoding: "utf8" });
  assert.notEqual(direct.status, 0, "an explicit contaminated file must not scan clean");
  assert.match(direct.stdout, /^PROD_MARKER_COUNT=1$/m);
  assert.match(direct.stdout, /^ENV_CONTAMINATED$/m);

  const link = join(dir, "release-link.env");
  symlinkSync(join(dir, "release.env"), link);
  const viaLink = spawnSync("bash", [SCAN, link], { encoding: "utf8" });
  assert.notEqual(viaLink.status, 0, "a symlinked explicit file must not scan clean");
});

// The fourth EnvironmentFile source. The unit must name all four, keep every path inside the slot tree,
// and carry one fail-closed guard per source so release.env is re-checked on every start.
test("the unit guards all four EnvironmentFile sources, including current/release.env", () => {
  const plan = run(OPTION_R, ["--check"]);
  assert.equal(plan.status, 0, plan.stderr);
  const envLines = plan.stdout.split("\n").filter((l) => l.startsWith("EnvironmentFile="));
  assert.equal(envLines.length, 4, "db, app, local and current/release.env");
  assert.ok(envLines.some((l) => l.includes("/current/release.env")), "release.env must be named");
  for (const line of envLines) {
    const path = line.replace(/^EnvironmentFile=-?/, "");
    assert.match(path, /^\/home\/shoslot\/pr9\/(env|current)\//, `env source outside the slot tree: ${path}`);
  }
  const guards = plan.stdout.split("\n").filter((l) => l.startsWith("ExecStartPre="));
  assert.equal(guards.length, 4, "one guard per source");
  for (const guard of guards) {
    assert.match(guard, /test -r /, "unreadable source must fail closed");
    assert.match(guard, /grep -qEi -- "defaultdb\|doadmin\|25061\|sho-prod-pool"/, "the marker set");
  }
});

// W59-F4's contract: exit 2 after a mutation must not read as "nothing changed". The refusal line now
// carries whether the host was already modified, so the operator knows whether --rollback is required.
test("a refusal reports whether the host was already mutated", () => {
  const src = read(OPTION_R);
  assert.match(src, /REFUSING \(partial=%s\)/, "the refusal line must carry the partial flag");
  assert.match(src, /MUTATED=1/, "the first mutation must raise it");
  assert.match(src, /MUTATED:-0/, "fail() must read it");
});
// `[ -e "$UNIT_PATH" ]`, so a host whose unit FILE is already gone but whose unit is still ACTIVE
// made no stop call at all and printed ROLLBACK_OK, exit 0 — a live slot reported as rolled back.
// Run against a sandbox copy: every path redirected into a temp dir, systemctl stubbed to answer
// `active` and to fail the stop. It must refuse, not report success.
test("rollback refuses to report success while the unit is still active", () => {
  // Two runs, so the assertion cannot be satisfied by "the script simply failed": the stopped host
  // must still roll back cleanly, and the live one must refuse. Same sandbox, different systemd.
  function rollbackWith(state, { link = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "sho-rollback-"));
    for (const sub of ["lib", "unit", "sudoers", "bin", "wants", join("home", "shoslot", "pr9")]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    if (link) symlinkSync(join(dir, "unit", "sho-pr9.service"), join(dir, "wants", "sho-pr9.service"));
    const scan = join(dir, "lib", "prod-marker-scan.sh");
    copyFileSync(SCAN, scan);
    chmodSync(scan, 0o755); // the script prechecks `[ -x "$MARKER_SCAN" ]`; without +x it never reaches R7
    const patched = read(OPTION_R)
      .replaceAll("/etc/systemd/system/sho-pr9.service", join(dir, "unit", "sho-pr9.service"))
      .replaceAll("/etc/systemd/system/multi-user.target.wants", join(dir, "wants"))
      .replaceAll("/etc/sudoers.d/50-sho-pr9", join(dir, "sudoers", "50-sho-pr9"))
      .replaceAll("/home/shoslot", join(dir, "home", "shoslot"))
      .replace(/^\[ "\$\(id -u\)" -eq 0 \].*$/m, '[ -n "$FAKE_ROOT" ] || fail "needs root"')
      .replace(/^\[ "\$\(uname -s\)" = 'Linux' \].*$/m, ":")
      .replace(/^hostname -s \| grep -qx "\$EXPECT_HOST" \\$/m, ":")
      .replace(/^  \|\| fail "host is not .*$/m, ":");
    writeFileSync(join(dir, "rollback.sh"), patched);
    // `active` + a stop that does not take = the host in the worst state: slot live, unit file gone.
    writeFileSync(
      join(dir, "bin", "systemctl"),
      `#!/bin/bash\ncase "$*" in *is-active*) echo ${state}; exit 0;; *disable*) exit 1;; *) exit 0;; esac\n`,
      { mode: 0o755 },
    );
    chmodSync(join(dir, "bin", "systemctl"), 0o755);
    return spawnSync("bash", [join(dir, "rollback.sh"), "--rollback"], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_ROOT: "1" },
    });
  }

  const live = rollbackWith("active");
  assert.doesNotMatch(live.stdout, /ROLLBACK_OK/, "a still-active unit is not a successful rollback");
  assert.notEqual(live.status, 0, "a still-active unit must make rollback exit non-zero");

  // Positive control: the same sandbox with a stopped unit still has to succeed, or the test above
  // would pass for a script that can never roll back at all.
  const stopped = rollbackWith("inactive");
  assert.match(stopped.stdout, /ROLLBACK_OK/, stopped.stderr);
  assert.equal(stopped.status, 0, stopped.stderr);

  // W59-F5: `systemctl enable` leaves a wants symlink. A rollback that removes the unit file but not the
  // link leaves systemd starting a unit that no longer exists. The link must be gone afterwards.
  const withLink = rollbackWith("inactive", { link: true });
  assert.match(withLink.stdout, /ROLLBACK_OK/, withLink.stderr);
  assert.equal(withLink.status, 0, withLink.stderr);
  // The sandbox path is derived from the temp dir the run used; assert on the script's own booleans.
  assert.match(withLink.stdout, /unit_disabled=1/, "the enable-symlink must be gone after rollback");
});

// The proof's own header: "a denial alone proves nothing: a missing file is also denied ... PASS
// requires both". The verdict only WARNED about prod_env_exists=0 and then still printed
// gap_closed=1, so an absent /etc/sho/app.env produced PROOF=PASS.
test("proof does not report PASS when the production env it probed was absent", () => {
  const body = read(PROOF);
  const warn = body.indexOf('[ "$prod_env_exists" -eq 0 ]');
  assert.ok(warn > 0, "the missing-file guard disappeared");
  const block = body.slice(warn, body.indexOf("fi", warn));
  assert.match(block, /gap=1/, "prod_env_exists=0 must fail the verdict, not only warn");
  assert.match(body, /if \[ "\$environ_readable" -eq 0 \]/, "an unreadable environ must be its own answer");
});
