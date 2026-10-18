import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { countsFromReport, failureReason, formatCounts } from "./assert-playwright-ran.mjs";

const script = fileURLToPath(new URL("./assert-playwright-ran.mjs", import.meta.url));

function stats(partial) {
  return { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...partial } };
}

test("all skipped fails", () => {
  const counts = countsFromReport(stats({ skipped: 92 }));
  assert.equal(counts.run, 0);
  assert.equal(counts.skipped, counts.total);
  assert.match(failureReason(counts), /Every test was skipped/);
});

test("zero tests fails", () => {
  const counts = countsFromReport(stats({}));
  assert.equal(counts.run, 0);
  assert.equal(counts.total, 0);
  assert.match(failureReason(counts), /No tests ran/);
});

test("a mix of passed and skipped is allowed", () => {
  const counts = countsFromReport(stats({ expected: 3, skipped: 1 }));
  assert.equal(counts.run, 3);
  assert.equal(counts.total, 4);
  assert.equal(failureReason(counts), null);
});

test("failures still count as ran, so this gate does not hide them", () => {
  const counts = countsFromReport(stats({ unexpected: 2 }));
  assert.equal(counts.run, 2);
  assert.equal(failureReason(counts), null);
});

test("flaky counts as ran", () => {
  const counts = countsFromReport(stats({ flaky: 1, skipped: 4 }));
  assert.equal(counts.run, 1);
  assert.notEqual(counts.skipped, counts.total);
  assert.equal(failureReason(counts), null);
});

test("without stats, suite status is counted", () => {
  const counts = countsFromReport({
    suites: [{
      specs: [{ tests: [{ status: "skipped" }, { status: "skipped" }] }],
      suites: [{ specs: [{ tests: [{ status: "expected" }] }] }],
    }],
  });
  assert.deepEqual(
    { expected: counts.expected, skipped: counts.skipped, run: counts.run, total: counts.total },
    { expected: 1, skipped: 2, run: 1, total: 3 },
  );
  assert.equal(failureReason(counts), null);
});

test("prints counts and exits 1 when skipped equals total", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-report-"));
  const file = join(dir, "playwright-report.json");
  writeFileSync(file, JSON.stringify(stats({ skipped: 7 })));
  const result = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected=0 unexpected=0 flaky=0 skipped=7 total=7 run=0/);
  assert.match(result.stderr, /::error::Every test was skipped/);
  assert.equal(result.stdout.includes("password"), false);
});

test("a missing report exits 1 and prints zeros", () => {
  const result = spawnSync(process.execPath, [script, join(tmpdir(), "no-such-playwright-report.json")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run=0/);
  assert.match(result.stderr, /missing or unreadable/);
});

test("unreadable JSON exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-report-"));
  const file = join(dir, "playwright-report.json");
  writeFileSync(file, "{not json");
  const result = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or unreadable/);
});

test("formatCounts lists every field", () => {
  assert.equal(
    formatCounts({ expected: 1, unexpected: 2, flaky: 3, skipped: 4, total: 10, run: 6 }),
    "expected=1 unexpected=2 flaky=3 skipped=4 total=10 run=6",
  );
});
