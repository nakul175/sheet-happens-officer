// CI tier — THE MANIFEST'S OWN HONESTY, CHECKED RATHER THAN BELIEVED.
//
// scripts/ci/ac-coverage.manifest.mjs says, for each AC clause of the frozen 35-ticket set, either that a named test
// exists (TESTED), that no in-repo test can reach it and why (NOT-TESTABLE-IN-REPO), or that it is simply unheld
// (UNTESTED). A manifest nobody checks is a report with a filename, so this file checks it against the filesystem:
//
//   1. shape      - every entry has a status from STATUSES; NOT-TESTABLE carries a reason from REASONS; anything that
//                   is not TESTED carries a note, so an exclusion always says why.
//   2. TESTED     - "path:line" names a file that EXISTS, the line is inside it, the `asserts` token really is in that
//                   file, and the file names the ticket (or its carrier, or `names`). A TESTED entry pointing at a test
//                   that has been deleted or renamed is red - the drift a report cannot catch.
//   3. coverage   - all 35 rows of the frozen set have at least one entry, and no entry cites a ticket outside it.
//   4. regression - scripts/ci/ac-coverage.baseline.json records which entries were TESTED when this was committed. An
//                   entry that drops from TESTED to UNTESTED (or to NOT-TESTABLE) is red. UNTESTED on its own is not a
//                   failure - it is counted and printed - because losing a test and recording the loss are different
//                   acts, and only the second one is allowed to be quiet.
//
// What it cannot check: whether a TESTED test is a GOOD test. See LIMIT in the manifest and the last assertion here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ENTRIES, LIMIT, REASONS, STATUSES, TICKETS, summarize } from "./ac-coverage.manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "ac-coverage.baseline.json");

/** The frozen set, written out here too on purpose: the manifest and this list must agree, and a diff is the alarm. */
const FROZEN_35 = [
  "2671", "2689", "2693", "2725", "2736", "2738", "2760", "2840", "2897", "2917",
  "2918", "2919", "2920", "2921", "2922", "2923", "2924", "2951", "2996", "2997",
  "2998", "3000", "3010", "3011", "3012", "3013", "3017", "3019", "3024", "3025",
  "3029", "3030", "3031", "3032", "3033",
];

const isTestPath = (path) => /^(tests|e2e|scripts)\//.test(path) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
/** The counts, printed on every run so drift is visible without opening a report. */
function report() {
  const counts = summarize();
  const line = [
    `AC coverage: ${counts.clauses} clauses over ${counts.ticketsCovered}/${TICKETS.length} tickets`,
    `TESTED ${counts.status.TESTED}`,
    `NOT-TESTABLE ${counts.status["NOT-TESTABLE-IN-REPO"]}`,
    `UNTESTED ${counts.status.UNTESTED}`,
    `| verified body ${counts.verified.body} / title ${counts.verified.title}`,
    `| reasons host ${counts.reason.host} process ${counts.reason.process} human ${counts.reason.human}`,
    `pointer ${counts.reason.pointer} deploy ${counts.reason.deploy}`,
  ].join(" ");
  // Printed, not asserted on: the counts are the point of the run, not a gate. A number that changes is meant to be
  // seen in the log. The gate is the baseline below, which only fails on a fall.
  console.log(`\n${line}\n`);
  return { counts, line };
}

test("AC coverage manifest: every entry is well formed, names a real test, and reasons are from the closed list", () => {
  const found = violations(ENTRIES);
  assert.deepEqual(found, [], `the manifest is dishonest in ${found.length} way(s):\n  ${found.join("\n  ")}`);
});

test("AC coverage manifest: the frozen 35 rows are all covered, and no ticket outside them appears", () => {
  assert.deepEqual([...TICKETS].sort(), [...FROZEN_35].sort(), "the manifest's TICKETS drifted from the frozen 35");
  assert.equal(TICKETS.length, 35);
  const covered = new Set(ENTRIES.map((entry) => entry.ticket));
  assert.deepEqual([...covered].sort(), [...FROZEN_35].sort(), "every frozen row must have at least one entry");
});

test("AC coverage manifest: no entry falls back from TESTED, and the counts are printed", () => {
  const { counts, line } = report();

  if (!existsSync(BASELINE_FILE)) {
    assert.fail(`no baseline at ${BASELINE_FILE}: commit one so a TESTED entry cannot quietly become UNTESTED`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const byId = new Map(ENTRIES.map((entry) => [entry.id, entry]));

  const regressions = [];
  for (const id of baseline.tested) {
    const entry = byId.get(id);
    if (!entry) regressions.push(`${id}: was TESTED, the entry is gone`);
    else if (entry.status !== "TESTED") regressions.push(`${id}: was TESTED, now ${entry.status}`);
  }
  assert.deepEqual(regressions, [],
    `AC coverage regressed since the baseline (${baseline.tested.length} TESTED):\n  ${regressions.join("\n  ")}\n`
    + "If the test really was deleted, change the baseline in the same commit and say why in the message.");

  assert.equal(baseline.clauses, counts.clauses, "the clause count moved: record the change in the baseline deliberately");
  assert.equal(baseline.status.TESTED, counts.status.TESTED,
    `TESTED moved from ${baseline.status.TESTED} to ${counts.status.TESTED}`);

  // Every status, not only the TESTED ids. `tested` above catches a fall from TESTED; it cannot see a clause moved from
  // UNTESTED ("no test asserts it today" - a debt) to NOT-TESTABLE-IN-REPO ("no test can ever reach it" - a permanent
  // exclusion). That reclassification is the one a ledger is laundered through, and until now it left every assertion
  // green (W173 §4.3). A status map per id is the alarm.
  if (!baseline.statuses || typeof baseline.statuses !== "object") {
    assert.fail("no statuses map in the baseline: record every entry's status, not just the TESTED ids, so an "
      + "UNTESTED -> NOT-TESTABLE reclassification is a deliberate commit and not a quiet edit");
  }
  const moved = [];
  for (const entry of ENTRIES) {
    const was = baseline.statuses[entry.id];
    if (was === undefined) moved.push(`${entry.id}: ${entry.status}, absent from the baseline`);
    else if (was !== entry.status) moved.push(`${entry.id}: ${was} -> ${entry.status}`);
  }
  const live = new Set(ENTRIES.map((entry) => entry.id));
  for (const id of Object.keys(baseline.statuses)) if (!live.has(id)) moved.push(`${id}: in the baseline, the entry is gone`);
  assert.deepEqual(moved, [],
    "an entry's status moved since the baseline (a reclassification, not a fall from TESTED):\n  "
    + `${moved.join("\n  ")}\nIf the move is right, change the baseline in the same commit and say why.`);

  // The totals are the map's own arithmetic, so a reader who trusts them is trusting a check.
  assert.deepEqual(baseline.status, counts.status, "the baseline's status totals disagree with the manifest");
  assert.equal(baseline.tickets, counts.ticketsCovered, "the baseline's ticket count disagrees with the manifest");

  assert.match(line, /TESTED \d+/, "the counts must be printed on every run");
  assert.match(LIMIT, /GOOD test/, "the limit paragraph must still say what a TESTED entry cannot prove");
});


/** Regex-escape a literal, so a ticket id is matched as an id and not as a pattern. */
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way an entry can be dishonest, as strings. Exported so a falsifier can feed a broken entry through it. */
export function violations(entries, root = ROOT) {
  const out = [];
  const seen = new Set();
  const frozen = new Set(FROZEN_35);

  for (const entry of entries) {
    const where = entry.id || JSON.stringify(entry).slice(0, 80);

    if (!entry.id || !entry.ticket || !entry.clause) out.push(`${where}: needs id, ticket and clause`);
    if (seen.has(entry.id)) out.push(`${where}: duplicate id`);
    seen.add(entry.id);
    if (!frozen.has(entry.ticket)) out.push(`${where}: ticket ${entry.ticket} is not in the frozen 35`);
    if (!STATUSES.includes(entry.status)) {
      out.push(`${where}: status ${entry.status} is not one of ${STATUSES.join("/")}`);
    }

    if (entry.status === "NOT-TESTABLE-IN-REPO") {
      if (!REASONS.includes(entry.reason)) {
        out.push(`${where}: NOT-TESTABLE needs a reason from ${REASONS.join("/")}, got ${JSON.stringify(entry.reason)}`);
      }
    } else if (entry.reason !== undefined) {
      out.push(`${where}: only NOT-TESTABLE entries carry a reason (got ${entry.reason} on ${entry.status})`);
    }

    if (entry.status !== "TESTED" && !(typeof entry.note === "string" && entry.note.trim())) {
      out.push(`${where}: ${entry.status} needs a note saying why - an exclusion without a reason is an oversight`);
    }

    if (entry.status !== "TESTED") {
      if (entry.test !== undefined || entry.asserts !== undefined) {
        out.push(`${where}: only TESTED entries name a test (drop test/asserts, or test the clause)`);
      }
      continue;
    }

    if (entry.verified !== "body" && entry.verified !== "title") {
      out.push(`${where}: verified must be "body" or "title", got ${JSON.stringify(entry.verified)}`);
    }

    const match = /^(.+):(\d+)$/.exec(entry.test ?? "");
    if (!match) {
      out.push(`${where}: test must be "path:line", got ${JSON.stringify(entry.test)}`);
      continue;
    }
    const [, path, lineText] = match;
    if (!isTestPath(path)) out.push(`${where}: ${path} is not a test file`);

    const file = resolve(root, path);
    if (!existsSync(file)) {
      out.push(`${where}: ${path} does not exist - the receipt is gone`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n").length;
    const line = Number(lineText);
    if (line < 1 || line > lines) out.push(`${where}: ${path}:${line} is past the end of a ${lines}-line file`);

    if (!(typeof entry.asserts === "string" && entry.asserts.trim())) {
      out.push(`${where}: TESTED needs an asserts token - otherwise nothing says what the test asserts`);
    } else if (!text.includes(entry.asserts)) {
      out.push(`${where}: ${path} does not contain the asserts token ${JSON.stringify(entry.asserts)}`);
    }

    const names = [entry.ticket, entry.carrier, entry.names].filter(Boolean);
    const named = names.some((name) => new RegExp(`(^|[^0-9A-Za-z])${escape(name)}([^0-9A-Za-z]|$)`).test(text));
    if (!named) {
      out.push(`${where}: nothing in ${path} names the ticket (${names.join(" / ")}) -`
        + " a reader going from ticket to test cannot arrive");
    }
  }

  const covered = new Set(entries.map((entry) => entry.ticket));
  for (const ticket of frozen) {
    if (!covered.has(ticket)) out.push(`frozen row ${ticket} has no entry - the manifest does not cover all 35`);
  }
  return out;
}

