// CONTAINMENT (slot 9, Option R). These tests are static/behavioural: nothing here runs on the staging host,
// needs root, or reads a real env file. They exist so the two runbook scripts cannot silently lose the property
// that makes them safe to run blind:
//   1. they refuse to act when a precondition fails (fail-closed, not "print ABORT and continue"),
//   2. they never print a value from an env file (booleans, counts and uid only),
//   3. re-running them does not break a good state.
// Evidence for every name/port/path asserted here is OS-IDENTITY-ISOLATION.md, cited in the scripts themselves.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
