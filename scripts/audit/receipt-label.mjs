#!/usr/bin/env node
// Receipt labelling: turns a receipt into an evidence class and a staging class mechanically.
//
// Why this exists: the execution ledger's two most load-bearing columns (`test@HEAD`, `staging`) were hand-typed
// row by row for 35 rows. A hand-typed label can say more than its receipt does, and nothing in the repo fails
// when it does. This script re-derives both labels from the receipt text and the cited SHA and prints the
// difference, so an inflated label is a non-zero exit instead of a paragraph nobody re-reads.
//
// Vocabulary is fixed by the packet and is not re-invented here:
//   evidence: UNPROVEN < LOCAL-ONLY < PARTIAL < AT-HEAD
//   staging:  NOT-STAGED < LOCAL-ONLY < PRE-ISOLATION-STAGED < ISOLATED-STAGED
//
// No dependency: node stdlib plus the local `git` binary.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EVIDENCE = ["UNPROVEN", "LOCAL-ONLY", "PARTIAL", "AT-HEAD"];
export const STAGING = ["NOT-STAGED", "LOCAL-ONLY", "PRE-ISOLATION-STAGED", "ISOLATED-STAGED"];
export const evidenceRank = (c) => EVIDENCE.indexOf(c);
export const stagingRank = (c) => STAGING.indexOf(c);

// ---------------------------------------------------------------------------------------------------------------
// 1. Reading a receipt: what is the receipt's own text, and what is it quoting?
// ---------------------------------------------------------------------------------------------------------------

/**
 * Split a receipt into lines tagged with whether they sit inside a fenced block, and whether that block reads as
 * a *quotation* (the script's source, the line a runbook says must be printed) rather than as this receipt's own
 * output.
 *
 * This is the difference between "the script prints PROOF=PASS" and "the script printed PROOF=PASS". A receipt
 * that quotes slot9-proof.sh — or the acceptance line a messenger "should require" — has produced no proof,
 * however many times the string `PROOF=PASS` appears in it.
 */
export function fencedLines(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let quoted = false;
  let intro = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      if (!inFence) {
        let body = "";
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*(```+|~~~+)/.test(lines[j])) break;
          body += lines[j] + "\n";
        }
        inFence = true;
        quoted = !isTranscriptFence(fence[2], intro, body);
      } else {
        inFence = false;
      }
      out.push({ line, quoted: false, fence: true });
      continue;
    }
    out.push({ line, quoted: inFence && quoted, fence: inFence });
    if (!inFence && line.trim()) intro = line;
  }
  return out;
}

/**
 * A fence is a transcript when its info string or the paragraph introducing it says so, or when its body carries
 * a shell prompt (`$ cmd`) — a command that was run with what came back. Anything else (bare `PROOF=PASS` under
 * "the line to require", shell source with `if`/`fi`/`echo`) is a quotation.
 */
function isTranscriptFence(info, intro, body) {
  if (/^[^\s]*(?:output|transcript|log|result)/i.test(info)) return true;
  if (/\b(?:output|transcript|log|it printed|printed|ran|reproduced|returned|exits?)\b/i.test(intro)) return true;
  return /^\s*[$%]\s+\S/m.test(body);
}

/** The lines that are the receipt speaking for itself: prose outside a quotation fence, plus any transcript. */
export function ownText(text) {
  return fencedLines(text)
    .filter((l) => !l.quoted)
    .map((l) => l.line)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Evidence class
// ---------------------------------------------------------------------------------------------------------------

/** A summary line from a run: the only thing that counts as a measurement. */
const OUTPUT = [
  /\b\d+\s+(?:passed|failed|skipped|todo|pending)\b/i, // vitest / node:test summary
  /\bexit(?:ed)?\s*(?:code\s*)?0\b/i,
  /\bPASS(?:ED)?\b/,
  /\bgreen\b/i,
  /\b\d+\/\d+\b/, // 40/40, 4/4
];

/** A quoted span that is a command: something a shell could have run. */
const COMMAND = /\b(?:npm|npx|node|pnpm|yarn|git|bash|sh|curl|psql|prisma|vitest|ss|systemctl|getent|ssh|make|python3?|tsx)\b/;

const LOCAL = /\b(?:darwin|macos|mac os x|localhost|127\.0\.0\.1|0\.0\.0\.0|dev mode|development mode|local-only|local only)\b/i;

/** Text that says out loud that the measurement is absent, incomplete, or at another head. */
const ABSENT = [
  /\bnot (?:re-?run|run|measured|executed|observed|proven|at this head|green)/i,
  /\bnever (?:run|ran|executed|observed|dispatched)\b/i,
  /\bno (?:run|measurement|summary line|line for this head)\b/i,
  /\bunproven\b/i,
  /\breds? stand\b/i,
  /\bneeds? (?:a|an|one) (?:linux|real|browser|mailbox|runner|ios)/i,
  /\bblock[- ]level\b/i,
  /\bpartial(?:ly)?\b/i,
  /\bdeferred\b/i,
  /\bunmeasured\b/i,
];

/** Text that claims the measurement is at the head under test. */
const AT_THIS_HEAD = /\b(?:at (?:this|the) head|at head|reproduced at|green at)\b/i;
/** Text that admits the measurement came from an earlier head, carried forward. */
const PRIOR_HEAD = /(?:^|[^\w])(?:carried|from C\d|C\d:|prior pass|earlier pass)/i;
/** The text states the tested file has not moved since the carried run. */
const FILE_SAME = /\b(?:SAME|same file|unchanged)\b/;

function quotedSpans(text) {
  const out = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  return out;
}

/**
 * A line that refuses a production action ("`systemctl restart sho` was not run"), which is a safety statement,
 * not a gap in the acceptance criteria. Without this filter every honest containment receipt reads as a failure.
 */
const NEGATED_ACTION =
  /\b(?:systemctl|restart|deploy\w*|ssh|push\w*|merge\w*|reboot|touch\w*)\b[^.;\n]{0,24}\b(?:was|were|is|has been)?\s*not\s+(?:run|used|executed|touched|performed|issued)/i;

const notAGap = (line) => NEGATED_ACTION.test(line);

/** Prose in backticks: a sentence, not a command. The packet's UNPROVEN case #2. */
export function allQuotedCommandsAreProse(text) {
  const spans = quotedSpans(text);
  if (spans.length === 0) return false;
  return spans.every((s) => {
    const firstWord = s.trim().split(/\s+/)[0];
    if (COMMAND.test(firstWord)) return false;
    return /\s/.test(s) && /[a-z]{3,}\s+[a-z]{3,}/i.test(s);
  });
}

function firstMatchLine(lines, res) {
  for (const line of lines) for (const re of res) if (re.test(line)) return line.trim();
  return null;
}

/**
 * Evidence class for a receipt, given the target head.
 *
 * @param {string} text receipt text
 * @param {{head?: string, cwd?: string, citedShas?: string[], testOnlySha?: string}} [opts]
 * @returns {{cls: string, reasons: string[], citedShas: string[]}}
 */
export function classifyEvidence(text, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const own = ownText(text);
  const lines = own.split("\n").filter((l) => l.trim());
  const reasons = [];
  const cited = opts.citedShas ?? citedShasIn(own);

  // A commit that only adds or changes a test is AT-HEAD for the test, never for the product AC.
  const testOnly = opts.testOnlySha ? isTestOnlyCommit(opts.testOnlySha, cwd) : false;
  if (testOnly) reasons.push(testOnlyReason(opts.testOnlySha));

  const output = firstMatchLine(lines, OUTPUT);
  if (!output) {
    if (opts.pointsAtRun) {
      reasons.push(
        `no summary line quoted: the label points at an earlier measurement (${clip(opts.pointsAtRun)}), ` +
          "so AT-HEAD is not re-derivable from this row",
      );
      return { cls: "PARTIAL", reasons, citedShas: cited };
    }
    reasons.push(
      allQuotedCommandsAreProse(own)
        ? "every quoted command is prose: no command was run and no output quoted"
        : "no test/command output quoted",
    );
    return { cls: "UNPROVEN", reasons, citedShas: cited };
  }
  reasons.push(`measurement: ${clip(output)}`);

  const local = firstMatchLine(lines, [LOCAL]);
  if (local) {
    reasons.push(`local measurement: ${clip(local)}`);
    return { cls: "LOCAL-ONLY", reasons, citedShas: cited };
  }

  if (testOnly) return { cls: "PARTIAL", reasons, citedShas: cited };

  const absent = firstMatchLine(lines.filter((l) => !notAGap(l)), ABSENT);
  if (absent) {
    reasons.push(`receipt states a gap: ${clip(absent)}`);
    return { cls: "PARTIAL", reasons, citedShas: cited };
  }

  // AT-HEAD also needs the cited SHA to be an ancestor of the head, and the run to be at that head.
  const headSha = opts.head ? revParse(opts.head, cwd) : null;
  if (opts.head && !headSha) {
    reasons.push(`--head ${opts.head} does not resolve to a commit`);
    return { cls: "PARTIAL", reasons, citedShas: cited };
  }
  const unreachable = cited.filter((s) => !isAncestor(s, headSha, cwd));
  if (unreachable.length) {
    reasons.push(
      `cited ${unreachable.map((s) => s.slice(0, 7)).join(", ")} not an ancestor of head ${headSha.slice(0, 7)} ` +
        `(merge-base --is-ancestor ${unreachable[0].slice(0, 7)} ${headSha.slice(0, 7)} → 1)`,
    );
    return { cls: "PARTIAL", reasons, citedShas: cited };
  }

  const atHead = AT_THIS_HEAD.test(own);
  if (PRIOR_HEAD.test(own) && !atHead) {
    const file = testFileIn(own);
    const anchor = cited[0] ?? headSha;
    if (file && fileUnchangedSince(anchor, headSha, file, cwd)) {
      reasons.push(`carried run accepted: ${file} unchanged since ${anchor.slice(0, 7)}`);
    } else if (FILE_SAME.test(own)) {
      reasons.push("carried run accepted: the receipt states the tested file is SAME");
    } else {
      reasons.push(
        file
          ? `carried run rejected: ${file} changed since ${anchor.slice(0, 7)}`
          : "carried forward from an earlier head with no tested-file assertion (no `SAME`), so AT-HEAD is not established",
      );
      return { cls: "PARTIAL", reasons, citedShas: cited };
    }
  }
  reasons.push(
    cited.length
      ? `cited ${cited.map((s) => s.slice(0, 7)).join(", ")} is an ancestor of head ${headSha.slice(0, 7)}`
      : "no cited SHA; run taken at head as written",
  );
  return { cls: "AT-HEAD", reasons, citedShas: cited };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Staging class
// ---------------------------------------------------------------------------------------------------------------

const DEPLOY =
  /(?:\b(?:ran|run|runs|running|executed?|logged in|ssh(?:ed|ing)?|connected|login|signed in)\b[^.\n]{0,24}\bas\s+`?deploy\b)|(?:`deploy`?\s+(?:user|account))|(?:deploy@)/i;
const PROD_RESTART = /\bsystemctl\s+restart\s+sho(?![\w-])/i;
const HOST_IDENTITY =
  /(?:^|[\s(])(?:host|unit|machine|server)\s*[=:]\s*\S+|(?:^|[\s(])on\s+[a-z0-9][a-z0-9.-]*\.[a-z]{2,6}\b|\bssh\s+(?:-\S+\s+)*\S+|(?:^|[\s(])[a-z._][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i;
/**
 * The slot's own identity, as an identity statement rather than a mention: `identity=shoslot`, `unit sho-pr9@9`,
 * `ran as slot 9`. A bare filename (`slot9-proof.sh`) is not an identity, or every receipt that reads the script
 * would be promoted a rung.
 */
function slotIdentityLine(lines) {
  const token = /\b(?:shoslot|sho-pr9[-@]?\w*|slot[\s_-]?\d\b|slot[\s_-]*(?:account|unit|host)\b)/i;
  const identityWord = /\b(?:account|unit|identity|user|host|ran as|runs as|logged in|login)\b/i;
  return lines.find((l) => token.test(l) && identityWord.test(l)) ?? null;
}

const PROOF = /\b(?:PROOF|CONTAINMENT)\s*=\s*(PASS|FAIL)\b/;

/**
 * Lines that carry a proof result the receipt produced itself.
 *
 * Three ways a `PROOF=PASS` string is *not* a result: it sits in a quotation fence (the script's source), it is
 * itself in backticks with requirement language around it ("the acceptance line the messenger should require is
 * `PROOF=PASS`"), or the line is a requirement in prose. All three appear in this project's real receipts, and any
 * of them would otherwise let a receipt that ran nothing claim a pass.
 */
export function proofLines(text) {
  const REQUIREMENT = /\b(?:should|must|require[sd]?|required|expects?|expected|acceptance line|to look for)\b/i;
  const BACKTICKED = /`[^`]*\b(?:PROOF|CONTAINMENT)\s*=\s*(?:PASS|FAIL)\b[^`]*`/;
  return fencedLines(text)
    .filter((l) => !l.quoted)
    .map((l) => l.line)
    .filter((line) => PROOF.test(line) && !BACKTICKED.test(line) && !REQUIREMENT.test(line));
}

/**
 * Staging class. The rule that makes inflation impossible: ISOLATED-STAGED needs the slot's own account/unit
 * identity AND a PROOF=PASS/CONTAINMENT=PASS line that the receipt produced itself. Any deploy identity caps the
 * result at PRE-ISOLATION-STAGED no matter what else is present — including a PROOF=PASS string copied out of the
 * script, which is a quotation and not a result.
 *
 * @param {string} text
 * @returns {{cls: string, reasons: string[]}}
 */
export function classifyStaging(text) {
  const own = ownText(text);
  const lines = own.split("\n").filter((l) => l.trim());
  const reasons = [];
  const deploy = firstMatchLine(lines, [DEPLOY]);
  const restart = firstMatchLine(lines.filter((l) => !notAGap(l)), [PROD_RESTART]);
  const host = firstMatchLine(lines, [HOST_IDENTITY]);
  const slot = slotIdentityLine(lines);
  const proofLine = (want) => {
    const hit = proofLines(text).filter((l) => PROOF.exec(l)?.[1] === want);
    return hit[0] ?? null;
  };
  const proofPass = proofLine("PASS");
  const proofFail = proofLine("FAIL");

  if (deploy || restart) {
    reasons.push(
      deploy
        ? `not isolated: the run is attributed to the deploy identity (${clip(deploy)})`
        : `not isolated: ${clip(restart)} acts on the production unit`,
    );
    if (proofPass) reasons.push(`PROOF=PASS cannot lift a deploy-identity receipt: ${clip(proofPass)}`);
    return { cls: "PRE-ISOLATION-STAGED", reasons };
  }

  if (slot && proofPass) {
    reasons.push(
      `slot identity: ${clip(slot)}`,
      `proof: ${clip(proofPass)}`,
      host ? `host identity: ${clip(host)}` : "the slot account/unit line is itself the identity",
    );
    return { cls: "ISOLATED-STAGED", reasons };
  }
  if (proofPass && !slot) {
    reasons.push(
      `${clip(proofPass)} with no slot account/unit identity: the pass is not attributable to an isolated slot`,
    );
    return { cls: "PRE-ISOLATION-STAGED", reasons };
  }
  if (proofFail) {
    reasons.push(`the slot's own proof failed: ${clip(proofFail)}`);
    return { cls: "PRE-ISOLATION-STAGED", reasons };
  }
  const quotedProof = fencedLines(text).find((l) => l.quoted && PROOF.test(l.line));
  if (quotedProof) {
    reasons.push(`PROOF=PASS appears only inside a quotation (${clip(quotedProof.line)}): nothing ran in a slot`);
  }
  if (slot || host) {
    reasons.push(
      slot
        ? `slot mentioned (${clip(slot)}) but no PROOF=PASS/CONTAINMENT=PASS line of the receipt's own`
        : `host identity (${clip(host)}) but no slot identity and no proof line`,
    );
    return { cls: "PRE-ISOLATION-STAGED", reasons };
  }
  const local = firstMatchLine(lines, [LOCAL]);
  if (local || firstMatchLine(lines, OUTPUT)) {
    reasons.push(
      `no host/slot identity line: the most the receipt shows is a local measurement (${clip(local ?? "local output")})`,
    );
    return { cls: "LOCAL-ONLY", reasons };
  }
  reasons.push("no host/slot identity line and no measurement: nothing was staged");
  return { cls: "NOT-STAGED", reasons };
}

// ---------------------------------------------------------------------------------------------------------------
// 4. git
// ---------------------------------------------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A full SHA for a possibly abbreviated one, or null when it is not a commit here. */
export function revParse(sha, cwd = process.cwd()) {
  try {
    return git(["rev-parse", "--verify", `${sha}^{commit}`], cwd);
  } catch {
    return null;
  }
}

export function isAncestor(sha, head, cwd = process.cwd()) {
  try {
    git(["merge-base", "--is-ancestor", sha, head], cwd);
    return true;
  } catch {
    return false;
  }
}

/** True when the commit's diff touches nothing but tests. */
export function isTestOnlyCommit(sha, cwd = process.cwd()) {
  let files;
  try {
    files = git(["show", "--pretty=format:", "--name-only", sha], cwd).split("\n").filter(Boolean);
  } catch {
    return false;
  }
  if (files.length === 0) return false;
  return files.every(isTestPath);
}

export function isTestPath(p) {
  return (
    /(?:^|\/)tests?\//.test(p) ||
    /\.test\.[cm]?[jt]sx?$/.test(p) ||
    /\.spec\.[cm]?[jt]sx?$/.test(p) ||
    /(?:^|\/)e2e\//.test(p)
  );
}

export function testFileIn(text) {
  const m = /((?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(text);
  return m ? m[1] : null;
}

export function fileUnchangedSince(from, to, file, cwd = process.cwd()) {
  try {
    return git(["diff", "--name-only", from, to, "--", file], cwd) === "";
  } catch {
    return false;
  }
}

function citedShasIn(text) {
  return [...text.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]).filter((s) => /[0-9]/.test(s));
}

function clip(s, n = 90) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function testOnlyReason(sha) {
  return `${sha.slice(0, 7)} changes only tests (tests/ or *.test.*): AT-HEAD for the test, not for the product AC`;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. The ledger: rows are receipts too
// ---------------------------------------------------------------------------------------------------------------

/**
 * Split one spreadsheet-style table row, honouring `\|` (the ledger writes `4 passed \| 8 expected fail` inside a
 * cell).
 */
export function splitRow(line) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Extract ledger rows: `| ID | Pri | fix@HEAD | test@HEAD | staging | note |`.
 *
 * The `test@HEAD` cell is the receipt for the evidence class — deliberately not the note column, which carries
 * commentary that would poison the classification (2693's note says the *review* was "never re-run", which says
 * nothing about the test). The staging class reads the whole row, because the staging prose ("ran as `deploy`")
 * lives in the note.
 */
export function parseLedger(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0])) continue;
    const [id, pri, fix, test, staging, ...rest] = cells;
    rows.push({
      id: Number(id),
      priority: pri,
      fixCell: fix,
      testCell: test,
      stagingCell: staging,
      noteCell: rest.join(" | "),
      claimedEvidence: claimedEvidence(test),
      claimedStaging: claimedStaging(staging),
      citedShas: citedShasIn(fix),
    });
  }
  return rows;
}

export function claimedEvidence(cell) {
  const m = /\b(AT-HEAD|PARTIAL|UNPROVEN)\b/.exec(cell);
  return m ? m[1] : null;
}

/** PRE-ISOLATION-STAGED before ISOLATED-STAGED: the longer token contains the shorter one. */
export function claimedStaging(cell) {
  const m = /\b(PRE-ISOLATION-STAGED|ISOLATED-STAGED|NOT-STAGED)\b/.exec(cell);
  return m ? m[1] : null;
}

/** A row that names a prior measurement instead of quoting it: `carried`, `C8:`, `W44`, `§2`, "was run". */
const POINTER =
  /\b(?:carried|C[0-9]|W[0-9]{2}|§\s?[\d.]+|passed|green|reproduced|measured|run|runs)\b|same file|\bSAME\b/i;

/**
 * Reclassify one row from its receipt.
 * @param {ReturnType<typeof parseLedger>[number]} row
 * @param {{head: string, cwd?: string}} opts
 */
export function reclassify(row, opts) {
  const cwd = opts.cwd ?? process.cwd();
  // A row whose own label says nothing was measured is not read as pointing at a measurement.
  const pointer = row.claimedEvidence === "UNPROVEN" ? null : (POINTER.exec(row.testCell)?.[0] ?? null);
  const evidence = classifyEvidence(row.testCell, {
    head: opts.head,
    cwd,
    citedShas: row.citedShas,
    testOnlySha: row.citedShas.length === 1 ? row.citedShas[0] : undefined,
    pointsAtRun: pointer,
  });
  const staging = classifyStaging([row.fixCell, row.testCell, row.stagingCell, row.noteCell].join(" \n"));
  const evidenceOver = row.claimedEvidence ? evidenceRank(row.claimedEvidence) > evidenceRank(evidence.cls) : false;
  const stagingOver = row.claimedStaging ? stagingRank(row.claimedStaging) > stagingRank(staging.cls) : false;
  return {
    id: row.id,
    wasEvidence: row.claimedEvidence ?? "?",
    nowEvidence: evidence.cls,
    wasStaging: row.claimedStaging ?? "?",
    nowStaging: staging.cls,
    over: evidenceOver || stagingOver,
    evidenceOver,
    stagingOver,
    unreachable: evidence.reasons.some((r) => r.includes("not an ancestor")),
    reason: [
      ...(evidenceOver ? [`evidence ${row.claimedEvidence} → ${evidence.cls}`] : []),
      ...(stagingOver ? [`staging ${row.claimedStaging} → ${staging.cls}`] : []),
      ...evidence.reasons,
      ...staging.reasons,
    ].join("; "),
  };
}


export function formatTable(results) {
  const head = ["row", "was", "now", "reason"];
  const lines = results.map((r) => [
    String(r.id),
    `${r.wasEvidence} / ${r.wasStaging}`,
    `${r.nowEvidence} / ${r.nowStaging}`,
    `${r.over ? "OVERCLAIM — " : "ok — "}${r.reason}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(" | ");
  return [fmt(head), widths.map((w) => "-".repeat(w)).join("-+-"), ...lines.map(fmt)].join("\n");
}

function tally(list) {
  const out = {};
  for (const v of list) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function formatCounts(results) {
  const ev = tally(results.map((r) => r.nowEvidence));
  const st = tally(results.map((r) => r.nowStaging));
  const wasEv = tally(results.map((r) => r.wasEvidence));
  const wasSt = tally(results.map((r) => r.wasStaging));
  const row = (label, keys, t) => `${label} ${keys.map((k) => `${k}=${t[k] ?? 0}`).join(" ")}`;
  return [
    `rows: ${results.length}`,
    row("claimed evidence:", EVIDENCE, wasEv),
    row("claimed staging: ", STAGING, wasSt),
    row("now     evidence:", EVIDENCE, ev),
    row("now     staging: ", STAGING, st),
    `overclaims: ${results.filter((r) => r.over).length} ` +
      `(evidence ${results.filter((r) => r.evidenceOver).length}, staging ${results.filter((r) => r.stagingOver).length}); ` +
      `cited SHAs not reachable from head: ${results.filter((r) => r.unreachable).length}`,
    `ISOLATED=${st["ISOLATED-STAGED"] ?? 0}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------------------------------------------

function usage() {
  return [
    "usage: node scripts/audit/receipt-label.mjs --ledger <file> --head <sha> [--cwd <repo>] [--json]",
    "       node scripts/audit/receipt-label.mjs --receipt <file> [--head <sha>] [--json]",
    "",
    "  --ledger   a ledger whose rows are `| ID | Pri | fix@HEAD | test@HEAD | staging | note |`",
    "  --head     the commit every citation is measured against (default HEAD)",
    "  --receipt  label one receipt file instead of a ledger",
    "  --cwd      git repository to resolve SHAs in (default: the current directory)",
    "  --json     machine-readable output",
    "",
    "exit: 0 = every label is supported by its receipt; 1 = at least one row is claimed higher than supported.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message));
    console.error(usage());
    return 2;
  }
  if (args.help || (!args.ledger && !args.receipt)) {
    console.log(usage());
    return args.help ? 0 : 2;
  }
  const cwd = args.cwd ?? process.cwd();
  const head = args.head ? (revParse(args.head, cwd) ?? args.head) : revParse("HEAD", cwd);

  if (args.receipt) {
    const text = readFileSync(args.receipt, "utf8");
    const evidence = classifyEvidence(text, { head, cwd });
    const staging = classifyStaging(text);
    if (args.json) {
      console.log(JSON.stringify({ receipt: args.receipt, head, evidence, staging }, null, 2));
    } else {
      console.log(args.receipt);
      console.log(`  head:     ${head}`);
      console.log(`  evidence: ${evidence.cls}`);
      for (const r of evidence.reasons) console.log(`    - ${r}`);
      console.log(`  staging:  ${staging.cls}`);
      for (const r of staging.reasons) console.log(`    - ${r}`);
    }
    return 0;
  }

  const rows = parseLedger(readFileSync(args.ledger, "utf8"));
  if (rows.length === 0) {
    console.error(`no ledger rows found in ${args.ledger}`);
    return 2;
  }
  const results = rows.map((r) => reclassify(r, { head, cwd }));
  if (args.json) {
    console.log(JSON.stringify({ head, rows: results }, null, 2));
  } else {
    console.log(`ledger: ${args.ledger}`);
    console.log(`head:   ${head}`);
    console.log("");
    console.log(formatTable(results));
    console.log("");
    console.log(formatCounts(results));
  }
  return results.some((r) => r.over) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main();

/**
 * True when this file is the entry point. Both spellings are accepted because macOS resolves `/tmp` to
 * `/private/tmp`: `import.meta.url` is the real path, `process.argv[1]` is whatever the caller typed.
 */
function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  const toUrl = (p) => pathToFileURL(p).href;
  try {
    return moduleUrl === toUrl(process.argv[1]) || moduleUrl === toUrl(realpathSync(process.argv[1]));
  } catch {
    return false;
  }
}

