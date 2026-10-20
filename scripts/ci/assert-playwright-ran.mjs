// Shard jobs and the one aggregate check for staging e2e.
// Prints counts only. Never prints a report body (it can hold page text).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function walk(suites, tallies) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === "skipped") tallies.skipped += 1;
        else if (test.status === "unexpected") tallies.unexpected += 1;
        else if (test.status === "flaky") tallies.flaky += 1;
        else if (test.status === "expected") tallies.expected += 1;
        else tallies.unexpected += 1;
      }
    }
    walk(suite.suites, tallies);
  }
}

export const SHARD_TOTAL = 20;

export function zeroCounts() {
  return { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0, run: 0 };
}

/** Marker written when the Playwright JSON report was not produced. It is not a count of 0 tests. */
export function missingMarker() {
  return { missing: true };
}

/** 20 when the parallel matrix runs, plus 1 when the serial job runs. */
export function expectedCountFiles(parallelFiles, serialFiles) {
  const shards = Number(parallelFiles) > 0 ? SHARD_TOTAL : 0;
  const serial = Number(serialFiles) > 0 ? 1 : 0;
  return shards + serial;
}

/** Counts from a Playwright JSON report or a counts file. `run` is every outcome that was not skipped. */
export function countsFromReport(report) {
  if (report && report.missing === true) return { ...zeroCounts(), missing: true };
  if (report && !report.stats && !report.suites && (report.expected !== undefined || report.run !== undefined || report.skipped !== undefined)) {
    const expected = num(report.expected);
    const unexpected = num(report.unexpected);
    const flaky = num(report.flaky);
    const skipped = num(report.skipped);
    const run = expected + unexpected + flaky;
    const total = run + skipped;
    return { expected, unexpected, flaky, skipped, total, run };
  }
  const stats = report?.stats;
  let expected;
  let unexpected;
  let flaky;
  let skipped;
  if (stats && typeof stats === "object") {
    expected = num(stats.expected);
    unexpected = num(stats.unexpected);
    flaky = num(stats.flaky);
    skipped = num(stats.skipped);
  } else {
    const tallies = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    walk(report?.suites, tallies);
    expected = tallies.expected;
    unexpected = tallies.unexpected;
    flaky = tallies.flaky;
    skipped = tallies.skipped;
  }
  const run = expected + unexpected + flaky;
  const total = run + skipped;
  return { expected, unexpected, flaky, skipped, total, run };
}

/**
 * Empty shard (no tests) passes. A shard whose tests were all skipped fails.
 * The run-wide run=0 check belongs to the aggregate job, not here.
 * requireTests (--require-tests, APL-2925): the job is the whole run, not one of many shards, so an empty run fails too.
 */
export function shardFailureReason(counts, { requireTests = false } = {}) {
  if (counts.total === 0) {
    return requireTests ? "No tests ran (total=0). This job is the whole run, so an empty run fails." : null;
  }
  if (counts.run === 0 || counts.skipped === counts.total) {
    return `Every test in this shard was skipped (skipped=${counts.skipped}, total=${counts.total}, run=${counts.run}).`;
  }
  return null;
}

/** Once across every shard: fail when nothing ran, or every collected test was skipped. */
export function aggregateFailureReason(counts) {
  if (counts.run === 0 || counts.skipped === counts.total) {
    return `Nothing ran across shards (run=${counts.run}, skipped=${counts.skipped}, total=${counts.total}).`;
  }
  return null;
}

/**
 * Problems with the set of count files, before the run=0 check.
 * A short download fails even when the files that arrived contain passing tests.
 * A missing-report marker fails even when the other files ran tests.
 */
export function aggregateFileProblems(received, expected, parts) {
  const problems = [];
  if (received < expected) {
    problems.push(`Received ${received} count files, expected ${expected}.`);
  }
  const missing = parts.filter((part) => part.missing).length;
  if (missing > 0) {
    problems.push(`${missing} count file(s) marked the Playwright report missing.`);
  }
  return problems;
}

export function sumCounts(parts) {
  const sum = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const part of parts) {
    sum.expected += num(part.expected);
    sum.unexpected += num(part.unexpected);
    sum.flaky += num(part.flaky);
    sum.skipped += num(part.skipped);
  }
  const run = sum.expected + sum.unexpected + sum.flaky;
  const total = run + sum.skipped;
  return { ...sum, run, total };
}

export function formatCounts(counts) {
  return `expected=${counts.expected} unexpected=${counts.unexpected} flaky=${counts.flaky} skipped=${counts.skipped} total=${counts.total} run=${counts.run}`;
}

export function countFilesIn(dir) {
  const found = [];
  function walkDir(current) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walkDir(full);
      else if (name.endsWith(".json")) found.push(full);
    }
  }
  walkDir(dir);
  return found.sort();
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`Missing ${name}.`);
  }
  return process.argv[index + 1];
}

function finish(counts, reason) {
  if (reason) {
    console.error(`::error::${reason}`);
    process.exit(1);
  }
}

function main() {
  const mode = arg("--mode");
  if (mode === "shard") {
    const reportPath = arg("--report");
    const countsPath = arg("--counts-out");
    const requireTests = process.argv.includes("--require-tests");
    let counts;
    try {
      counts = countsFromReport(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch {
      counts = missingMarker();
      console.log(`Shard report missing or unreadable (${reportPath}).`);
    }
    writeFileSync(countsPath, JSON.stringify(counts) + "\n");
    if (counts.missing) {
      console.log("Missing Playwright JSON report (missing=true).");
      if (requireTests) finish(counts, "Missing Playwright JSON report: the run produced no results.");
      return;
    }
    console.log(`Shard counts: ${formatCounts(counts)}`);
    if (counts.total === 0 && !requireTests) console.log("Empty shard: no tests in this shard.");
    finish(counts, shardFailureReason(counts, { requireTests }));
    return;
  }
  if (mode === "expected") {
    console.log(expectedCountFiles(arg("--parallel"), arg("--serial")));
    return;
  }
  if (mode === "aggregate") {
    const dir = arg("--dir");
    const expectedText = arg("--expected");
    if (!/^\d+$/.test(expectedText)) {
      throw new Error(`Expected count is not a whole number (${expectedText}).`);
    }
    const expected = Number(expectedText);
    const files = countFilesIn(dir);
    const parts = [];
    let unreadable = 0;
    for (const file of files) {
      try {
        parts.push(countsFromReport(JSON.parse(readFileSync(file, "utf8"))));
      } catch {
        unreadable += 1;
        console.log(`Unreadable counts file: ${file}`);
      }
    }
    console.log(`Aggregate files: ${files.length} expected: ${expected}`);
    const problems = aggregateFileProblems(files.length, expected, parts);
    if (unreadable > 0) problems.push(`${unreadable} count file(s) were unreadable.`);
    const counted = parts.filter((part) => !part.missing);
    const counts = sumCounts(counted);
    console.log(`Aggregate counts: ${formatCounts(counts)}`);
    if (problems.length === 0) {
      const reason = aggregateFailureReason(counts);
      if (reason) problems.push(reason);
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      process.exit(1);
    }
    return;
  }
  throw new Error(`Unknown mode ${mode}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
