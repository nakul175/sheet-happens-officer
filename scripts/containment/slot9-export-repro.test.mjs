// CONTAINMENT (slot 9). The published pin is a sha256 that a human is asked to trust before running the
// runbooks as root. That only means something if re-cutting the same commit reproduces the same bytes: if
// two cuts differ, the hash identifies "a cut taken at time T", not "this commit's contents", and nobody
// can tell a re-cut from a tampered tarball. The handoff's first cut did differ from its second - gzip's
// header timestamp, tar's nanosecond PAX mtime and macOS's com.apple.provenance xattr were all leaking in.
// These tests hold the three properties that make the artifact usable as a pin:
//   1. two cuts of the same commit are byte-identical (the defect these tests were written against),
//   2. the manifest verifies from a FRESH extraction and every file equals `git show <sha>:<path>`,
//   3. the shipped set covers every dependency the two runbooks source or call - a missing one fails the
//      root run on the host, not here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXPORT = join(here, "slot9-export.sh");
const RUNBOOKS = ["slot9-optionR.sh", "slot9-proof.sh"];
// A lib ships executable exactly when a shipped runbook exec-tests it with `[ -x ... ]`
// (slot9-optionR.sh:179 does that to the scanner). prod-marker-scan.sh is *invoked* as
// `bash "$MARKER_SCAN"`, so it would run at 0644 - but the guard beside it refuses without +x, so shipping
// it 0644 makes the artifact fail its own precondition on the host. That happened for real on the 94cf6d9
// root run: `REFUSING (partial=0): marker scanner missing`, immediately after MANIFEST verified 5/5,
// because file mode is not part of a sha256. unit-env-sources.sh is only ever sourced, so it stays 0644.
const EXEC_LIBS = ["prod-marker-scan.sh"];
const LIBS = ["unit-env-sources.sh"];
const rel = (p) => `scripts/containment/${p}`;

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC" };

function git(...args) {
  const res = spawnSync("git", ["-C", REPO, ...args], { encoding: "buffer", env });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

const HEAD = git("rev-parse", "HEAD").toString().trim();

// One cut into an outdir the test owns. Returns { sha, tarball }.
function cut() {
  const outdir = mkdtempSync(join(tmpdir(), "slot9-repro-"));
  const res = spawnSync("bash", [EXPORT, "HEAD", outdir], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...env, REPO },
  });
  assert.equal(res.status, 0, `export failed (${res.status}):\n${res.stderr}`);
  const sha = /^TARBALL_SHA256=([0-9a-f]{64})$/m.exec(res.stdout)?.[1];
  const tarball = /^TARBALL=(.+)$/m.exec(res.stdout)?.[1];
  assert.ok(sha, `export printed no TARBALL_SHA256:\n${res.stdout}`);
  assert.ok(tarball, `export printed no TARBALL:\n${res.stdout}`);
  return { sha, tarball };
}

function extract(tarball) {
  const dest = mkdtempSync(join(tmpdir(), "slot9-x-"));
  const res = spawnSync("tar", ["-xzf", tarball, "-C", dest], { encoding: "utf8", env });
  assert.equal(res.status, 0, `extraction failed: ${res.stderr}`);
  return join(dest, "slot9");
}

test("two cuts of the same commit are byte-identical (the pin is reproducible)", () => {
  const a = cut();
  // Deliberately cross a second boundary: the old cut path differed only in metadata stamped at export
  // time, so two cuts that land inside one second could agree by luck and hide the defect.
  spawnSync("sleep", ["1.1"]);
  const b = cut();
  assert.equal(
    a.sha,
    b.sha,
    `two cuts of ${HEAD.slice(0, 7)} produced different tarballs:\n  ${a.sha}\n  ${b.sha}\n` +
      "A published hash is only a pin if re-cutting the same commit reproduces it.",
  );
test("MANIFEST.sha256 verifies from a fresh extraction, and each file is the commit's blob", () => {
  const root = extract(cut().tarball);

  const check = spawnSync("shasum", ["-a", "256", "-c", "MANIFEST.sha256"], {
    encoding: "utf8",
    cwd: root,
    env,
  });
  assert.equal(check.status, 0, `manifest did not verify:\n${check.stdout}${check.stderr}`);
  const lines = check.stdout.trim().split("\n");
  for (const line of lines) assert.match(line, /: OK$/, `manifest line not OK: ${line}`);
  assert.deepEqual(
    lines.map((l) => l.replace(/: OK$/, "")).sort(),
    ["COMMIT", ...EXEC_LIBS.map((l) => rel(`lib/${l}`)), ...LIBS.map((l) => rel(`lib/${l}`)), ...RUNBOOKS.map(rel)].sort(),
    "the manifest must cover exactly the shipped files",
  );

  // COMMIT is the full 40-char sha of the commit the bytes came from - not the short one in the filename.
  const recorded = readFileSync(join(root, "COMMIT"), "utf8").trim();
  assert.match(recorded, /^[0-9a-f]{40}$/, `COMMIT must hold a full sha, got ${JSON.stringify(recorded)}`);
  assert.equal(recorded, HEAD, "COMMIT does not name the commit that was exported");

  // Byte-identical to the object in git, so the tarball cannot carry an edited copy of a reviewed script.
  for (const path of [...RUNBOOKS.map(rel), ...LIBS.map((l) => rel(`lib/${l}`))]) {
    assert.deepEqual(
      readFileSync(join(root, path)),
      git("show", `${HEAD}:${path}`),
      `${path} in the artifact differs from git show ${HEAD.slice(0, 7)}:${path}`,
    );
  }
});

test("modes in the artifact: runbooks and exec-tested libs executable, sourced libs not", () => {
  const root = extract(cut().tarball);
  const mode = (path) => statSync(join(root, path)).mode & 0o777;
  for (const r of RUNBOOKS) assert.equal(mode(rel(r)), 0o755, `${r} must be 0755`);
  for (const l of EXEC_LIBS) assert.equal(mode(rel(`lib/${l}`)), 0o755, `lib/${l} must be 0755 - a shipped runbook exec-tests it`);
  for (const l of LIBS) assert.equal(mode(rel(`lib/${l}`)), 0o644, `lib/${l} must be 0644 - it is sourced, never exec-tested`);
  assert.equal(mode("COMMIT"), 0o644);
});

test("the shipped set covers every dependency the runbooks source or call", () => {
  const shipped = new Set(
    [...readFileSync(EXPORT, "utf8").matchAll(/^(?:\s+)(scripts\/containment\/[A-Za-z0-9._\/-]+\.sh)$/gm)].map((m) => m[1]),
  );
  const needed = new Set(RUNBOOKS.map(rel));
  for (const runbook of RUNBOOKS) {
    const body = readFileSync(join(here, runbook), "utf8");
    // libs referenced as $(dirname "${BASH_SOURCE[0]}")/lib/<name>.sh, plus the "NEXT:" hand-off.
    for (const m of body.matchAll(/\/lib\/([A-Za-z0-9._-]+\.sh)\b/g)) needed.add(rel(`lib/${m[1]}`));
    for (const m of body.matchAll(/\b(slot9-[A-Za-z0-9._-]+\.sh)\b/g)) needed.add(rel(m[1]));
  }
  const missing = [...needed].filter((p) => !shipped.has(p));
  assert.deepEqual(missing, [], `the export does not ship ${missing.join(", ")} - a root run would fail on the host`);
  assert.deepEqual(
    [...shipped].sort(),
    [...needed].sort(),
    "the export ships files no runbook names (an unpinned extra cannot be reviewed as part of the run)",
  );
});

});
