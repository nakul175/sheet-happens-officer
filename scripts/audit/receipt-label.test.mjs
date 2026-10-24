// The rules that stop a receipt being labelled as more than it is, pinned one rejection at a time.
//
// Each fixture under scripts/audit/fixtures/ is a receipt written the way this project actually writes them: a
// sentence of provenance, a fence with a summary line, sometimes a fence that quotes the script instead of its
// output. The tests name the class that receipt may reach, and the class it may never reach.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyEvidence,
  classifyStaging,
  proofLines,
  parseLedger,
  reclassify,
  splitRow,
} from "./receipt-label.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "scripts/audit/fixtures");
const SCRIPT = join(ROOT, "scripts/audit/receipt-label.mjs");
/** The head the packet's C9 run is measured against. */
const HEAD = "208a279";
/** A commit whose diff touches src/ as well as tests/ (SHO-2693). */
const PRODUCT_SHA = "2286bce";
/** A commit whose diff touches only tests/keyboard-sheet-2738.test.tsx. */
const TEST_ONLY_SHA = "f83c7b4";

const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const runScript = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });

// --- AC1: a deploy identity is never isolated, whatever else the receipt quotes ---------------------------------

test("AC1 a receipt that ran as deploy is PRE-ISOLATION-STAGED, never ISOLATED-STAGED", () => {
  const receipt = fixture("ran-as-deploy.md");
  const { cls, reasons } = classifyStaging(receipt);
  assert.equal(cls, "PRE-ISOLATION-STAGED");
  assert.match(reasons.join("\n"), /deploy identity/);
});

test("AC1 PROOF=PASS quoted out of the script is not a proof line the receipt produced", () => {
  const receipt = fixture("ran-as-deploy.md");
  // The fence is script source (`echo "PROOF=PASS"`, `if ... then ... fi`), and the prose asks for the line.
  assert.ok(receipt.includes('echo "PROOF=PASS"'));
  assert.deepEqual(proofLines(receipt), [], "no line of this receipt is a proof it produced");
  assert.notEqual(classifyStaging(receipt).cls, "ISOLATED-STAGED");
});

test("AC1 with the deploy sentence removed the same quotation still yields no isolation", () => {
  const receipt = fixture("ran-as-deploy.md").replace(/Deployed at[\s\S]*?ran as `deploy`:/, "");
  assert.ok(!/ran as `deploy`/.test(receipt));
  const { cls, reasons } = classifyStaging(receipt);
  assert.notEqual(cls, "ISOLATED-STAGED");
  assert.equal(cls, "LOCAL-ONLY");
  assert.match(reasons.join("\n"), /quotation/);
});

test("a real slot receipt (host + slot identity + PROOF=PASS of its own) is ISOLATED-STAGED", () => {
  const { cls, reasons } = classifyStaging(fixture("isolated-real.md"));
  assert.equal(cls, "ISOLATED-STAGED", reasons.join("; "));
});

test("the slot's account/unit line is itself the identity: no separate host= line is required", () => {
  const receipt = fixture("isolated-real.md").replace(/^host=.*$/m, "");
  assert.equal(classifyStaging(receipt).cls, "ISOLATED-STAGED");
});

test("PROOF=PASS with no slot identity is not attributable to an isolated slot", () => {
  const receipt = "host=sho-staging.internal\n\nRan the gate; it printed:\n\n```\nPROOF=PASS\n```\n";
  const { cls, reasons } = classifyStaging(receipt);
  assert.equal(cls, "PRE-ISOLATION-STAGED");
  assert.match(reasons.join("\n"), /no slot account\/unit identity/);
});

test("a proof that FAILED does not stage anything", () => {
  const receipt = fixture("isolated-real.md").replace("PROOF=PASS", "PROOF=FAIL");
  assert.equal(classifyStaging(receipt).cls, "PRE-ISOLATION-STAGED");
});

test("refusing the production unit is a safety line, not a gap in the criteria", () => {
  const receipt = fixture("isolated-real.md");
  assert.match(receipt, /`systemctl restart sho` was not run/);
  assert.equal(classifyEvidence(receipt, { head: HEAD }).cls, "AT-HEAD");
});

// --- AC2: no host/slot identity line means LOCAL-ONLY -----------------------------------------------------------

test("AC2 a receipt with no host/slot identity line is LOCAL-ONLY", () => {
  const { cls, reasons } = classifyStaging(fixture("no-host-line.md"));
  assert.equal(cls, "LOCAL-ONLY");
  assert.match(reasons.join("\n"), /no host\/slot identity line/);
});

test("AC2 a bare local run with no identity line at all is LOCAL-ONLY too", () => {
  // No darwin, no localhost: nothing but a fence of vitest output.
  const receipt = ["# Receipt", "", "```", "$ npx vitest run tests/x.test.ts", "Tests  7 passed (7)", "```"].join("\n");
  assert.equal(classifyStaging(receipt).cls, "LOCAL-ONLY");
});

test("AC2 reading the pinning script's name is not an identity line", () => {
  const receipt = "Read `scripts/containment/slot9-proof.sh`; nothing was executed.\n\n`3 passed (3)` was quoted from C8.";
  assert.equal(classifyStaging(receipt).cls, "LOCAL-ONLY");
});

// --- AC3: a test-only commit is AT-HEAD for the test, never for the product AC -----------------------------------

test("AC3 a test-only commit cannot be AT-HEAD for a product AC", () => {
  assert.equal(git("show", "--pretty=format:", "--name-only", TEST_ONLY_SHA), "tests/keyboard-sheet-2738.test.tsx");
  const receipt = `Fix \`${TEST_ONLY_SHA}\`; ran \`npx vitest run tests/keyboard-sheet-2738.test.tsx\`:\n\n\`\`\`\n Tests  3 passed (3)\n\`\`\`\n`;
  const { cls, reasons } = classifyEvidence(receipt, {
    head: HEAD,
    cwd: ROOT,
    citedShas: [TEST_ONLY_SHA],
    testOnlySha: TEST_ONLY_SHA,
  });
  assert.equal(cls, "PARTIAL");
  assert.match(reasons.join("\n"), /changes only tests .*AT-HEAD for the test, not for the product AC/);
});

test("AC3 the same receipt against a commit that touches src/ stays AT-HEAD", () => {
  const receipt = `Fix \`${PRODUCT_SHA}\`; ran \`npx vitest run tests/sho-2693.test.ts\`:\n\n\`\`\`\n Tests  23 passed (23)\n\`\`\`\n`;
  const { cls, reasons } = classifyEvidence(receipt, {
    head: HEAD,
    cwd: ROOT,
    citedShas: [PRODUCT_SHA],
    testOnlySha: PRODUCT_SHA,
  });
  assert.equal(cls, "AT-HEAD", reasons.join("; "));
});

// --- AC4: a SHA that is not reachable from --head is flagged ------------------------------------------------------

test("AC4 a cited SHA that is not an ancestor of --head is flagged and printed", () => {
  const stray = git("rev-list", "--all", "--not", HEAD, "--max-count=1");
  assert.ok(stray.length >= 7, "the repo needs a commit outside the head's history for this test");
  const receipt = `Fix \`${stray.slice(0, 7)}\`; ran \`npx vitest run tests/x.test.ts\` at this head:\n\n\`\`\`\n Tests  3 passed (3)\n\`\`\`\n`;
  const { cls, reasons } = classifyEvidence(receipt, { head: HEAD, cwd: ROOT, citedShas: [stray.slice(0, 7)] });
  assert.equal(cls, "PARTIAL");
  const joined = reasons.join("\n");
  assert.match(joined, /not an ancestor of head/);
  assert.ok(joined.includes(stray.slice(0, 7)), "the cited SHA is printed");
  assert.ok(joined.includes(HEAD), "the head SHA is printed");
});

test("AC4 an unresolvable --head cannot produce AT-HEAD", () => {
  const receipt = "Ran the suite:\n\n```\n$ npx vitest run tests/x.test.ts\n Tests  3 passed (3)\n```\n\nFix `2286bce`.";
  assert.equal(classifyEvidence(receipt, { head: "deadbeefdeadbeef", cwd: ROOT }).cls, "PARTIAL");
});

// --- AC5: the ledger run, table and counts -----------------------------------------------------------------------

test("a ledger row that claims more than its receipt supports is an overclaim, and the run exits 1", () => {
  const res = runScript(["--ledger", join(FIXTURES, "ledger-overclaim.md"), "--head", HEAD, "--cwd", ROOT]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout, /row\s+\| was\s+\| now\s+\| reason/);
  assert.match(res.stdout, /OVERCLAIM/);
  // 9002 claims ISOLATED-STAGED on a deploy receipt; 9003 claims AT-HEAD on a test-only commit.
  const line9002 = res.stdout.split("\n").find((l) => l.startsWith("9002"));
  assert.match(line9002, /ISOLATED-STAGED.*PRE-ISOLATION-STAGED/);
  const line9003 = res.stdout.split("\n").find((l) => l.startsWith("9003"));
  assert.match(line9003, /AT-HEAD.*PARTIAL/);
  assert.match(res.stdout, /ISOLATED=0/);
});

test("a ledger whose labels its receipts support exits 0", () => {
  const res = runScript(["--ledger", join(FIXTURES, "ledger-supported.md"), "--head", HEAD, "--cwd", ROOT]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /rows: 1/);
  assert.match(res.stdout, /overclaims: 0/);
});

test("the ledger parser reads five cells and the escaped pipe a summary line needs", () => {
  assert.deepEqual(splitRow("| 1 | low | x | `90 passed \\| 8 expected fail (98)` | NOT-STAGED | — |"), [
    "1",
    "low",
    "x",
    "`90 passed | 8 expected fail (98)`",
    "NOT-STAGED",
    "—",
  ]);
  const rows = parseLedger(fixture("ledger-overclaim.md"));
  assert.deepEqual(rows.map((r) => r.id), [9001, 9002, 9003]);
  assert.equal(rows[1].claimedEvidence, "AT-HEAD");
  assert.equal(rows[1].claimedStaging, "ISOLATED-STAGED");
  assert.equal(rows[1].citedShas[0], "1a3aea0");
});

test("a row labelled UNPROVEN is not read as pointing at a measurement", () => {
  const row = parseLedger("| 1 | low | YES `2286bce` | **UNPROVEN** — no run | NOT-STAGED | needs a Linux host |")[0];
  const now = reclassify(row, { head: HEAD, cwd: ROOT });
  assert.equal(now.nowEvidence, "UNPROVEN");
  assert.equal(now.over, false);
});

// --- C9 itself, when the ledger is reachable (it lives outside the app worktree in the ops repo) -----------------

const C9 = resolve(
  ROOT,
  "app/sho-status-plan/execution/LEDGER-35-C9.md",
);
const C9_ABSOLUTE =
  "/Users/athena/.codex/.chatgpt-projects/g-p-6ab89116b65c81919bb561fed2d716c0/cline-team/app/sho-status-plan/execution/LEDGER-35-C9.md";
const c9Path = existsSync(C9_ABSOLUTE) ? C9_ABSOLUTE : C9;

test("C9 over LEDGER-35-C9.md at head 208a279 prints 35 rows and reports ISOLATED=0", { skip: !existsSync(c9Path) ? `LEDGER-35-C9.md not reachable from ${ROOT}` : false }, () => {
  const res = runScript(["--ledger", c9Path, "--head", HEAD, "--cwd", ROOT]);
  assert.match(res.stdout, /row\s+\| was\s+\| now\s+\| reason/);
  assert.match(res.stdout, /rows: 35/);
  assert.match(res.stdout, /ISOLATED=0/);
  assert.match(res.stdout, /ISOLATED-STAGED=0/);
  assert.match(res.stdout, /claimed staging:.*PRE-ISOLATION-STAGED=2/);
  assert.ok(res.status === 0 || res.status === 1, `unexpected exit ${res.status}: ${res.stderr}`);
});
