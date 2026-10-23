// The ledger census, pinned against the three defects it exists to catch.
//
// Every case here is a defect a real ledger shipped: C12 bound row 3031's file to `7572df1`, C13 called `f2dc225`
// reachable when it is not an ancestor, and C13's §4c put four `AT-HEAD-PASS` rows in the `UNPROVEN` bucket. The
// fixture is a two-row ledger that carries those shapes, so a grammar change that stops catching them fails here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertedPairs, bucketOf, census, rowsOf, spans } from "./ledger-census.mjs";
import * as vocab from "./ledger-census.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "scripts/audit/fixtures");
const SCRIPT = join(ROOT, "scripts/audit/ledger-census.mjs");
const FIXTURE = join(FIXTURES, "ledger-census-drift.md");
const HEAD = "HEAD";

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
const touches = (sha) =>
  execFileSync("git", ["diff-tree", "-r", "--no-commit-id", "--name-only", sha], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

// --- AC1: a bound sha that does not touch its file is a false pair, and it makes the census red -----------------
test("AC1 a false carrier pair is reported and the script exits non-zero", () => {
  // The C12 defect, verbatim: 7572df1 carries two files, neither of them the one row 3031 bound it to.
  const files = touches("7572df1");
  assert.ok(files.length > 0, "7572df1 is a real commit in this history");
  assert.ok(!files.includes("tests/no-proc-environ-2917.test.ts"), "fixture premise: 7572df1 does not carry that file");

  const result = census({ ledger: FIXTURE, head: HEAD, cwd: ROOT });
  const falsePair = result.pairs.falsePairs.find((p) => p.sha === "7572df1");
  assert.ok(falsePair, "the false pair is found");
  assert.equal(falsePair.file, "tests/no-proc-environ-2917.test.ts");
  assert.ok(result.defects.some((d) => d.startsWith("false pair: row 9301")));

  const proc = run(["--ledger", FIXTURE, "--head", HEAD, "--cwd", ROOT]);
  assert.equal(proc.status, 1, "a false pair is a red exit");
  assert.match(proc.stdout, /CENSUS=DRIFT/);
});

// --- AC2: correction prose after the em dash binds nothing -------------------------------------------------------
test("AC2 a sha after the em dash is correction prose, not a pair", () => {
  const { pairs } = assertedPairs(
    "`tests/apl-2736.test.ts` ← `6d4ee55` (intro) — `7572df1` is not a carrier of this file",
  );
  assert.deepEqual(
    pairs.map((p) => p.sha),
    ["6d4ee55"],
  );
  // The same grammar reads the fixture row 9302 the same way.
  const rows = rowsOf(readFileSync(FIXTURE, "utf8"));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    assertedPairs(rows[1].carrier, null).pairs.map((p) => p.sha),
    ["6d4ee55"],
  );
});

test("AC2 a file is only established by a path written before the sha it binds", () => {
  // C13's row 3024 shape: the product-side sha comes first, so the trailing path must not re-target it.
  const { pairs } = assertedPairs(
    "`tests/return-to.test.ts` ← `736e2cc` (intro); `08a42fd` is a product-side commit (`package.json`, `src/proxy.ts`)",
  );
  assert.deepEqual(pairs, [
    { file: "tests/return-to.test.ts", sha: "736e2cc" },
    { file: "tests/return-to.test.ts", sha: "08a42fd" },
  ]);
  assert.ok(!pairs.some((p) => p.file === "src/proxy.ts"), "the parenthetical does not become the binding target");
});

// --- AC3: a census table that disagrees with the rows' own cells is drift ---------------------------------------
test("AC3 a staging census that disagrees with the cells is drift, and agreement is not", () => {
  const md = readFileSync(FIXTURE, "utf8");
  // The fixture's table lists 9302 NOT-STAGED and 9301 LOCAL-ONLY, which is what the cells say.
  const clean = census({ ledger: FIXTURE, head: HEAD, cwd: ROOT });
  assert.equal(
    clean.defects.filter((d) => d.includes("census drift")).length,
    0,
    "the fixture's own census agrees with its cells",
  );

  // Flip one bucket and the same ledger must go red with the row named.
  const flipped = md.replace("| **NOT-STAGED** | **1** | 9302 |", "| **NOT-STAGED** | **1** | 9301 |");
  const tmp = join(FIXTURES, ".ledger-census-flipped.tmp.md");
  execFileSync("sh", ["-c", `cat > ${tmp}`, ], { input: flipped });
  const drifted = census({ ledger: tmp, head: HEAD, cwd: ROOT });
  execFileSync("rm", ["-f", tmp]);
  assert.ok(
    drifted.defects.some((d) => d.includes("staging census drift") && d.includes("9302")),
    "the moved row is named",
  );
  assert.ok(drifted.defects.some((d) => d.includes("9301")));
});

// --- AC4: a reach claim on a non-ancestor is charged, a negative citation is not --------------------------------
test("AC4 ancestry is charged only where the file claims reach", () => {
  const result = census({ ledger: FIXTURE, head: HEAD, cwd: ROOT });
  const isAncestor = (sha) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, HEAD], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  for (const sha of result.ancestry.notAncestor) assert.equal(isAncestor(sha), false);
  assert.deepEqual(result.ancestry.assertedNotAncestor, [], "every citation in the fixture is an ancestor");
  assert.ok(spans("`a` ← `b`").length === 2);
// --- AC5: the label axis names a git fact, never a deployment state ------------------------------------------------
// C15 shipped 15 rows labelled `ISOLATED-STAGED` while its staging class of that name was 0. The label meant "the
// fixing commit is reachable from the candidate head" — a fact about git, not about any deployment — and a reader who
// saw `ISOLATED-STAGED=15` concluded fifteen tickets were staged. The name was the defect, so the label axis may not
// borrow a staging class at all: one token, one meaning.
test("AC5 the label vocabulary shares no token with the staging axis, and the longer label wins over FIXED", () => {
  assert.ok(vocab.LABELS.includes("FIXED-ON-CANDIDATE-BRANCH"), "the label for a fix on the candidate branch is named");
  assert.ok(!vocab.LABELS.includes("ISOLATED-STAGED"), "the label axis must not reuse a staging class");
  assert.deepEqual(
    vocab.LABELS.filter((l) => vocab.STAGING_CLASSES.includes(l)),
    [],
    "no class is counted on both axes",
  );
  // `\bFIXED\b` matches inside `FIXED-ON-CANDIDATE-BRANCH` (the dash is a word boundary), so longest-first must win.
  assert.equal(
    bucketOf("**FIXED-ON-CANDIDATE-BRANCH** — fix at head, no fail-without on this line, so not **FIXED**", vocab.LABELS),
    "FIXED-ON-CANDIDATE-BRANCH",
  );
  assert.equal(bucketOf("**FIXED** — pin green, fail-without quoted", vocab.LABELS), "FIXED");
});

test("AC5 a LABEL cell that opens with a staging class is a defect that names the right label", () => {
  const md = readFileSync(FIXTURE, "utf8").replace("| LOCAL-ONLY | **FIXED** |", "| LOCAL-ONLY | **ISOLATED-STAGED** |");
  const tmp = join(FIXTURES, ".ledger-label-lie.tmp.md");
  writeFileSync(tmp, md);
  let result;
  try {
    result = census({ ledger: tmp, head: HEAD, cwd: ROOT });
  } finally {
    rmSync(tmp, { force: true });
  }
  assert.ok(
    result.defects.some(
      (d) => d.includes("row 9301") && d.includes("ISOLATED-STAGED") && d.includes("FIXED-ON-CANDIDATE-BRANCH"),
    ),
    `the row and the label to use instead are both named:\n${result.defects.join("\n")}`,
  );
});

});
