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

export function zeroCounts() {
  return { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0, run: 0 };
}

/** Counts from a Playwright JSON report or a counts file. `run` is every outcome that was not skipped. */
export function countsFromReport(report) {
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
 */
export function shardFailureReason(counts) {
  if (counts.total === 0) return null;
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
    let counts;
    try {
      counts = countsFromReport(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch {
      counts = zeroCounts();
      console.log(`Shard report missing or unreadable (${reportPath}). Treating this shard as empty.`);
    }
    writeFileSync(countsPath, JSON.stringify(counts) + "\n");
    console.log(`Shard counts: ${formatCounts(counts)}`);
    if (counts.total === 0) console.log("Empty shard: no tests in this shard.");
    finish(counts, shardFailureReason(counts));
    return;
  }
  if (mode === "aggregate") {
    const dir = arg("--dir");
    const files = countFilesIn(dir);
    const parts = [];
    for (const file of files) {
      try {
        parts.push(countsFromReport(JSON.parse(readFileSync(file, "utf8"))));
      } catch {
        console.log(`Skipping unreadable counts file: ${file}`);
      }
    }
    const counts = sumCounts(parts);
    console.log(`Aggregate files: ${parts.length}`);
    console.log(`Aggregate counts: ${formatCounts(counts)}`);
    finish(counts, aggregateFailureReason(counts));
    return;
  }
  throw new Error(`Unknown mode ${mode}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
