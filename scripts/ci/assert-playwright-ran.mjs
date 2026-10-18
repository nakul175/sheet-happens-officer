// Fail a staging e2e job when Playwright ran nothing, or skipped every test.
// Prints counts only. Never prints the report body (it can hold page text).
import { readFileSync } from "node:fs";
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

/** Counts from a Playwright JSON report. `run` is every outcome that was not skipped. */
export function countsFromReport(report) {
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

/** Why this report must fail the job, or null when at least one test ran and was not skipped. */
export function failureReason(counts) {
  if (counts.run !== 0 && counts.skipped !== counts.total) return null;
  if (counts.total === 0) {
    return "No tests ran (run=0, total=0). A staging e2e job must run at least one test that is not skipped.";
  }
  return `Every test was skipped (skipped=${counts.skipped}, total=${counts.total}, run=${counts.run}). A staging e2e job must run at least one test that is not skipped.`;
}

export function formatCounts(counts) {
  return `expected=${counts.expected} unexpected=${counts.unexpected} flaky=${counts.flaky} skipped=${counts.skipped} total=${counts.total} run=${counts.run}`;
}

function main() {
  const file = process.argv[2] || "playwright-report.json";
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0, run: 0 };
    console.log(`Playwright JSON report (${file}): ${formatCounts(counts)}`);
    console.error(`::error::No tests ran. The Playwright JSON report was missing or unreadable (${file}).`);
    process.exit(1);
  }
  const counts = countsFromReport(report);
  console.log(`Playwright JSON report (${file}): ${formatCounts(counts)}`);
  const reason = failureReason(counts);
  if (reason) {
    console.error(`::error::${reason}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
