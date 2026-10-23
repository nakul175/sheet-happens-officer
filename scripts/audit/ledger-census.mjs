#!/usr/bin/env node
// Ledger census: re-derives, from the ledger's own cells, the censuses a C-series ledger quotes about itself.
//
// Why this exists: every C-series ledger so far has hand-typed its censuses — "91 asserted pairs / 75 unique",
// "9 / 25 / 1 / 0 staged", "6 / 1 / 14 / 14 evidence" — into prose that nothing recomputes. Three of the last four
// versions were audited wrong on exactly that number, and each time the repair was another hand count. This script
// is the counter: it parses the rows, derives the carrier and ancestry facts from git, computes each census itself,
// and exits non-zero when the prose disagrees with the file it sits in.
//
// Two rules it enforces, both learned from the audits:
//   1. A carrier binding is `file <- sha`. Anything after the first em dash in a carrier cell is correction prose
//      (was / dropped / refutation) and is NOT an assertion — that is how row 3031's `7572df1` removal is read.
//      A bare backticked sha in the assertion part binds to the file it follows, which is why a product-side sha
//      parked in the same clause ("`08a42fd` is a product-side carrier") reads as a false carrier claim.
//   2. A census is the grouping of the 35 rows by their own columns. A census table that puts a row in a different
//      bucket than that row's cell says is a drift defect, whatever the arithmetic sums to.
//
// No dependency: node stdlib plus the local `git` binary.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyEvidence, classifyStaging, splitRow } from "./receipt-label.mjs";

export const PAIR_SCOPE = /^(?:tests|src|scripts|e2e|prisma|public|deploy|\.github)\//;
const SHA = /^[0-9a-f]{7,40}$/;
const ROW_ID = /^\d{4}$/;
/** Correction prose starts at the first em dash; a hyphen is part of the prose, not the cut. */
const CORRECTION_CUT = /\u2014/;
/** A citation that says, in its own sentence, that the sha is not on this head is not an assertion of reach. */
const NEGATIVE_CLAIM = /\b(?:not\s+an?\s+ancestor|not\s+reachable|NOT-ANCESTOR|has\s+not\s+landed|never\s+landed)\b/i;
/** Words that do assert reach: "named and reachable", "the fix landed", "in the candidate line". */
const REACH_CLAIM = /\b(?:reachable|landed|in the candidate line|is an ancestor|on this head|at this head)\b/i;

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
const gitOr = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

/** Every backticked span of a cell, in order. */
export const spans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

/**
 * The asserted `(file, sha)` pairs of one carrier cell.
 *
 * Grammar: segments are separated by `;`. A segment may open with a backticked file, else `same file` (or a
 * segment with no file of its own) continues the previous row's or the same cell's current file. Every backticked
 * sha in a segment binds to that segment's file. The cell is cut at the first em dash first.
 */
export function assertedPairs(cell, prevFile = null) {
  const asserted = cell.split(CORRECTION_CUT)[0];
  const pairs = [];
  let file = prevFile;
  for (const segment of asserted.split(";")) {
    const tokens = spans(segment).filter((s) => !/\s/.test(s));
    // The file a sha binds to is the file named *before* it (`file <- sha`). A path inside a trailing
    // parenthetical ("`08a42fd` is a product-side carrier (`package.json`, `src/proxy.ts`)") is prose about
    // another commit, not the target of a binding — reading it as one would move the sha to a file it happens
    // to touch and hide the false claim instead of reporting it.
    const firstSha = tokens.findIndex((t) => SHA.test(t));
    const fileAt = tokens.findIndex((t) => PAIR_SCOPE.test(t));
    if (fileAt >= 0 && (firstSha < 0 || fileAt < firstSha)) file = tokens[fileAt];
    if (!file) continue;
    for (const t of tokens) if (SHA.test(t)) pairs.push({ file, sha: t });
  }
  return { pairs, file };
}

/** Rows of the ledger's row table: `| NNNN | symptom | carrier | measured | staging | LABEL |`. */
export function rowsOf(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length !== 6 || !ROW_ID.test(cells[0])) continue;
    rows.push({
      id: cells[0],
      symptom: cells[1],
      carrier: cells[2],
      measured: cells[3],
      staging: cells[4],
      label: cells[5],
    });
  }
  return rows;
}

/** The bucket vocabulary, longest token first so `PRE-ISOLATION-STAGED` never reads as `ISOLATED-STAGED`. */
export function bucketOf(cell, vocabulary) {
  for (const token of [...vocabulary].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${token.replace(/-/g, "\\-")}\\b`).test(cell)) return token;
  }
  return null;
}


/**
 * A census table under a heading: `| **BUCKET** | **n** | 1234, 2345, … |`. Returns `{bucket: [ids]}` so both the
 * membership and the arithmetic can be checked against the rows.
 */
export function censusTable(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase().includes(heading.toLowerCase()));
  if (start < 0) return null;
  const table = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      if (line.trim() === "" && Object.keys(table).length === 0) continue;
      if (Object.keys(table).length > 0) break;
      continue;
    }
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const name = cells[0].replace(/\*/g, "").replace(/`/g, "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9 -]*$/.test(name) || name === "TOTAL") continue; // header and total rows are not buckets
    table[name.replace(/\s+/g, " ")] = (cells[2] ?? "").match(/\b\d{4}\b/g) ?? [];
  }
  if (Object.keys(table).length) return table;
  // Prose form, one paragraph: "`UNPROVEN=6` (2760, 2920, …), `LOCAL-ONLY=1`, `PARTIAL=14`, `AT-HEAD=14`".
  const prose = {};
  for (let i = start + 1; i < Math.min(lines.length, start + 12); i++) {
    for (const m of lines[i].matchAll(/`?([A-Z][A-Z0-9-]+)=(\d+)`?(?:\s*\(([^)]*)\))?/g)) {
      prose[m[1]] = (m[3] ?? "").match(/\b\d{4}\b/g) ?? [];
      prose[`${m[1]}#count`] = Number(m[2]);
    }
  }
  return Object.keys(prose).some((k) => !k.endsWith("#count")) ? prose : null;
}

const touched = new Map();
function filesTouched(sha, cwd) {
  if (!touched.has(sha)) {
    const out = gitOr(["diff-tree", "-r", "--no-commit-id", "--name-only", sha], cwd);
    touched.set(sha, out === null ? null : out.split("\n").filter(Boolean));
  }
  return touched.get(sha);
}

/** The commit that introduced a file: `--diff-filter=A`, oldest first (`git log` prints newest first). */
export function introCommit(file, cwd) {
  const lines = (gitOr(["log", "--diff-filter=A", "--format=%h", "--", file], cwd) ?? "").split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

const ancestor = (sha, head, cwd) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const isCommit = (sha, cwd) => gitOr(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd) !== null;

/** The sentence around a match, so a citation can be read with the words that qualify it. */
function sentenceAround(text, index, length) {
  const before = text.lastIndexOf(". ", index);
  const after = text.indexOf(". ", index + length);
  return text.slice(before < 0 ? 0 : before + 2, after < 0 ? text.length : after + 2);
}

/** Non-fenced prose: command transcripts quote other shas and are not citations of this file. */
function proseLines(markdown) {
  const out = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```+|~~~+)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}


/**
 * The whole census of one ledger.
 * @param {{ledger: string, head?: string, cwd?: string}} opts
 */
export function census(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const markdown = readFileSync(opts.ledger, "utf8");
  const head = git(["rev-parse", opts.head ?? "HEAD"], cwd).trim();
  const rows = rowsOf(markdown);
  const defects = [];

  // --- 1. the pair census ---------------------------------------------------------------------------------------
  const occurrences = [];
  const perRow = {};
  let prevFile = null;
  for (const row of rows) {
    const { pairs, file } = assertedPairs(row.carrier, prevFile);
    prevFile = file ?? prevFile;
    perRow[row.id] = pairs.length;
    for (const p of pairs) occurrences.push({ ...p, row: row.id });
  }
  const uniquePairs = new Map();
  for (const p of occurrences) uniquePairs.set(`${p.file}\u0000${p.sha}`, p);

  const falsePairs = [];
  const missingFiles = [];
  for (const p of uniquePairs.values()) {
    const files = filesTouched(p.sha, cwd);
    if (files === null) falsePairs.push({ ...p, carries: "unknown sha (not in this repository)" });
    else if (!files.includes(p.file)) falsePairs.push({ ...p, carries: files.join(",") || "(empty commit)" });
    if (gitOr(["cat-file", "-e", `${head}:${p.file}`], cwd) === null && !missingFiles.includes(p.file)) {
      missingFiles.push(p.file);
    }
  }
  for (const p of falsePairs) defects.push(`false pair: row ${p.row} ${p.file} <- ${p.sha} carries ${p.carries}`);
  for (const f of missingFiles) defects.push(`file missing at ${head.slice(0, 7)}: ${f}`);


  // --- 2. ancestry of every sha the file cites (fenced transcripts are not citations) --------------------------
  const rowIdOfLine = new Map();
  const carrierOfLine = new Map();
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length === 6 && ROW_ID.test(cells[0])) {
      rowIdOfLine.set(line, cells[0]);
      carrierOfLine.set(line, cells[2]);
    }
  }
  const citations = [];
  for (const line of proseLines(markdown)) {
    const row = rowIdOfLine.get(line) ?? null;
    for (const m of line.matchAll(/(?:^|[^0-9a-z])([0-9a-f]{7,40})(?![0-9a-z])/g)) {
      const sha = m[1];
      if (!isCommit(sha, cwd)) continue; // a token that names no commit is a word, not a citation
      const sentence = sentenceAround(line, m.index, sha.length);
      const carrier = assertedPairs(carrierOfLine.get(line) ?? "").pairs.some((p) => p.sha === sha);
      citations.push({
        sha,
        row,
        // A reach claim is either a carrier binding (a carrier that is not on the line is not a carrier of this
        // head) or a sentence that says the commit is reachable / landed. "W164's review (`952bafe`)" is neither:
        // it is a citation of work done somewhere, and is counted but not charged.
        claimsReach: !NEGATIVE_CLAIM.test(sentence) && (carrier || REACH_CLAIM.test(sentence)),
      });
    }
  }
  const cited = [...new Set(citations.map((c) => c.sha))];
  const notAncestor = cited.filter((s) => !ancestor(s, head, cwd));
  const assertedNotAncestor = [...new Set(citations.filter((c) => c.claimsReach && !ancestor(c.sha, head, cwd)).map((c) => c.sha))];
  for (const sha of assertedNotAncestor) {
    const where = [...new Set(citations.filter((c) => c.sha === sha && c.claimsReach).map((c) => c.row ?? "prose"))];
    defects.push(
      `false ancestry: ${sha} is not an ancestor of ${head.slice(0, 7)} but is cited as if it were (${where.join(", ")})`,
    );
  }

  // --- 3. the label and staging censuses, from the rows' own cells ----------------------------------------------
  const labels = {};
  const staging = {};
  for (const row of rows) {
    const label = bucketOf(row.label, ["FIXED", "ISOLATED-STAGED", "PARTIAL", "DECISION NEEDED", "NO-DEFECT-REPRODUCED"]);
    const stage = bucketOf(row.staging.split("(")[0], ["PRE-ISOLATION-STAGED", "ISOLATED-STAGED", "LOCAL-ONLY", "NOT-STAGED"]);
    if (!label) defects.push(`row ${row.id}: no label in the LABEL cell`);
    if (!stage) defects.push(`row ${row.id}: no staging class in the staging cell`);
    (labels[label ?? "?"] ??= []).push(row.id);
    (staging[stage ?? "?"] ??= []).push(row.id);
  }

  // --- 4. does each census table list the rows its own columns put there? --------------------------------------
  const drift = (tableName, heading, fromCells) => {
    const claimed = censusTable(markdown, heading);
    if (!claimed) {
      defects.push(`${tableName}: census table (${heading}) not found`);
      return null;
    }
    for (const bucket of new Set([...Object.keys(claimed), ...Object.keys(fromCells)])) {
      if (bucket.endsWith("#count")) continue;
      const want = [...(fromCells[bucket] ?? [])].sort();
      const got = [...(claimed[bucket] ?? [])].sort();
      const claimedCount = claimed[`${bucket}#count`];
      const onlyCells = want.filter((id) => !got.includes(id));
      const onlyTable = got.filter((id) => !want.includes(id));
      if (onlyCells.length || onlyTable.length) {
        defects.push(
          `${tableName} drift in ${bucket}: cells ${want.length} [${want.join(",")}] vs table ${got.length} ` +
            `[${got.join(",")}]` +
            (onlyCells.length ? `; ${onlyCells.join(",")} only in the cells` : "") +
            (onlyTable.length ? `; ${onlyTable.join(",")} only in the table` : ""),
        );
      } else if (got.length === 0 && claimedCount !== undefined && claimedCount !== want.length) {
        defects.push(`${tableName} count drift in ${bucket}: cells ${want.length} vs table ${claimedCount}`);
      }
    }
    return claimed;
  };
  const labelCensus = drift("label census", "4a. Labels", labels);
  const stagingCensus = drift("staging census", "4b. Staging", staging);

  // --- 5. the class each row's own cells earn, against the class the cell claims -------------------------------
  const restaged = [];
  for (const row of rows) {
    const claimed = bucketOf(row.staging.split("(")[0], [
      "PRE-ISOLATION-STAGED",
      "ISOLATED-STAGED",
      "LOCAL-ONLY",
      "NOT-STAGED",
    ]);
    const derived = classifyStaging([row.carrier, row.measured, row.staging, row.label].join(" \n")).cls;
    if (claimed && claimed !== derived) {
      restaged.push({ row: row.id, claimed, derived });
      defects.push(`staging mis-class: row ${row.id} claims ${claimed}, its own receipt reads ${derived}`);
    }
  }
  const reevidenced = [];
  const evidence = {};
  for (const row of rows) {
    const claimed = bucketOf(row.measured, ["AT-HEAD", "PARTIAL", "UNPROVEN"]);
    const derived = classifyEvidence(row.measured, { head, cwd }).cls;
    (evidence[derived] ??= []).push(row.id);
    if (claimed && claimed !== derived) {
      reevidenced.push({ row: row.id, claimed, derived });
      defects.push(`evidence mis-class: row ${row.id} claims ${claimed}, its own receipt reads ${derived}`);
    }
  }
  const evidenceCensus = drift("evidence census", "4c. Evidence", evidence);

  return {
    ledger: opts.ledger,
    head,
    rows: rows.length,
    rowIds: rows.map((r) => r.id),
    pairs: {
      occurrences: occurrences.length,
      unique: uniquePairs.size,
      repeats: occurrences.length - uniquePairs.size,
      shas: new Set(occurrences.map((p) => p.sha)).size,
      files: new Set(occurrences.map((p) => p.file)).size,
      perRow,
      falsePairs,
      missingFiles,
    },
    ancestry: {
      cited: cited.length,
      ancestors: cited.length - notAncestor.length,
      notAncestor,
      assertedNotAncestor,
    },
    labels,
    staging,
    evidence,
    labelCensus,
    stagingCensus,
    evidenceCensus,
    restaged,
    reevidenced,
    defects,
  };
}

export function render(r) {
  const count = (o) => Object.entries(o).map(([k, v]) => `${k}=${v.length}`).join(" ");
  const total = (o) => Object.values(o).reduce((n, v) => n + v.length, 0);
  const lines = [
    `ledger: ${r.ledger}`,
    `head:   ${r.head.slice(0, 7)}`,
    `rows parsed: ${r.rows}  (${r.rowIds.join(",")})`,
    `pairs asserted (occurrences): ${r.pairs.occurrences}   unique (file,sha): ${r.pairs.unique}   ` +
      `repeats: ${r.pairs.repeats}`,
    `unique shas: ${r.pairs.shas}   unique files: ${r.pairs.files}`,
    `pairs whose sha does not touch the file: ${r.pairs.falsePairs.length}`,
  ];
  for (const p of r.pairs.falsePairs) lines.push(`  FALSE-PAIR row ${p.row} ${p.file} <- ${p.sha} carries ${p.carries}`);
  lines.push(
    `files missing at head: ${r.pairs.missingFiles.length}` +
      (r.pairs.missingFiles.length ? ` ${r.pairs.missingFiles.join(",")}` : ""),
  );
  lines.push(
    `ancestry: cited ${r.ancestry.cited}  ancestors ${r.ancestry.ancestors}  ` +
      `not-ancestors ${r.ancestry.notAncestor.length}` +
      (r.ancestry.notAncestor.length ? ` [${r.ancestry.notAncestor.join(",")}]` : ""),
  );
  lines.push(
    `  cited as reachable but not an ancestor: ${r.ancestry.assertedNotAncestor.length}` +
      (r.ancestry.assertedNotAncestor.length ? ` [${r.ancestry.assertedNotAncestor.join(",")}]` : ""),
  );
  lines.push(`census labels  (from the cells): ${count(r.labels)}   total ${total(r.labels)}`);
  lines.push(`census staging (from the cells): ${count(r.staging)}   total ${total(r.staging)}`);
  lines.push(`census evidence (re-derived):    ${count(r.evidence)}   total ${total(r.evidence)}`);
  lines.push(`staging re-derived: agree ${r.rows - r.restaged.length} / disagree ${r.restaged.length}`);
  for (const x of r.restaged) lines.push(`  row ${x.row}: cell says ${x.claimed}, receipt reads ${x.derived}`);
  lines.push(`evidence re-derived: disagree ${r.reevidenced.length}`);
  for (const x of r.reevidenced) lines.push(`  row ${x.row}: cell says ${x.claimed}, receipt reads ${x.derived}`);
  lines.push(`defects: ${r.defects.length}`);
  for (const d of r.defects) lines.push(`  - ${d}`);
  lines.push(r.defects.length === 0 ? "CENSUS=OK" : "CENSUS=DRIFT");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    if (a === "--json") out.json = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.ledger) {
    console.error("usage: node scripts/audit/ledger-census.mjs --ledger <file> [--head <sha>] [--cwd <repo>] [--json]");
    console.error("  --ledger  a C-series ledger: `| ID | symptom | carrier (file <- sha) | measured | staging | LABEL |`");
    console.error("  --head    the commit every citation is measured against (default HEAD)");
    console.error("  --cwd     git repository to resolve SHAs in (default: the current directory)");
    console.error("  --json    print the census as JSON instead of the report");
    return 2;
  }
  let result;
  try {
    result = census({ ledger: args.ledger, head: args.head, cwd: args.cwd ?? process.cwd() });
  } catch (err) {
    console.error(`ledger-census: ${err.message}`);
    return 2;
  }
  console.log(args.json ? JSON.stringify(result, null, 2) : render(result));
  return result.defects.length === 0 ? 0 : 1;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const url = (p) => pathToFileURL(realpathSync(p)).href;
  try {
    return url(process.argv[1]) === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) process.exit(main());

