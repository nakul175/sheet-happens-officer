import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateFailureReason,
  countsFromReport,
  formatCounts,
  shardFailureReason,
  sumCounts,
} from "./assert-playwright-ran.mjs";

const script = fileURLToPath(new URL("./assert-playwright-ran.mjs", import.meta.url));

function stats(partial) {
  return { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...partial } };
}

function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("an empty shard passes", () => {
  const counts = countsFromReport(stats({}));
  assert.equal(counts.total, 0);
  assert.equal(counts.run, 0);
  assert.equal(shardFailureReason(counts), null);
});

test("an all-skipped shard fails", () => {
  const counts = countsFromReport(stats({ skipped: 7 }));
  assert.equal(counts.run, 0);
  assert.equal(counts.skipped, counts.total);
  assert.match(shardFailureReason(counts), /Every test in this shard was skipped/);
});

test("a normal shard with a mix of passed and skipped passes", () => {
  const counts = countsFromReport(stats({ expected: 3, skipped: 1 }));
  assert.equal(counts.run, 3);
  assert.equal(counts.total, 4);
  assert.equal(shardFailureReason(counts), null);
});

test("failures and flakes count as ran on a shard", () => {
  assert.equal(shardFailureReason(countsFromReport(stats({ unexpected: 2 }))), null);
  assert.equal(shardFailureReason(countsFromReport(stats({ flaky: 1, skipped: 4 }))), null);
});

test("aggregate run=0 fails", () => {
  const counts = sumCounts([
    countsFromReport(stats({})),
    countsFromReport(stats({})),
  ]);
  assert.equal(counts.run, 0);
  assert.equal(counts.skipped, counts.total);
  assert.match(aggregateFailureReason(counts), /Nothing ran across shards/);
});

test("aggregate of an all-skipped run fails", () => {
  const counts = sumCounts([
    countsFromReport(stats({ skipped: 4 })),
    countsFromReport(stats({ skipped: 2 })),
  ]);
  assert.equal(counts.skipped, 6);
  assert.equal(counts.skipped, counts.total);
  assert.match(aggregateFailureReason(counts), /Nothing ran across shards/);
});

test("a normal aggregate run passes, including an empty shard beside it", () => {
  const counts = sumCounts([
    countsFromReport(stats({})),
    countsFromReport(stats({ expected: 5, skipped: 1 })),
    countsFromReport(stats({ unexpected: 1 })),
  ]);
  assert.equal(counts.run, 6);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.total, 7);
  assert.equal(aggregateFailureReason(counts), null);
});

test("aggregate fails when skipped equals total even if run is non-zero on a hand-built tally", () => {
  const counts = { expected: 2, unexpected: 0, flaky: 0, skipped: 2, total: 2, run: 2 };
  assert.equal(counts.skipped, counts.total);
  assert.match(aggregateFailureReason(counts), /Nothing ran across shards/);
});

test("without stats, suite status is counted", () => {
  const counts = countsFromReport({
    suites: [{
      specs: [{ tests: [{ status: "skipped" }, { status: "expected" }] }],
    }],
  });
  assert.equal(counts.expected, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(shardFailureReason(counts), null);
});

test("shard cli: empty report exits 0 and writes zero counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-shard-"));
  const report = join(dir, "playwright-report.json");
  const counts = join(dir, "playwright-counts.json");
  writeFileSync(report, JSON.stringify(stats({})));
  const result = runScript(["--mode", "shard", "--report", report, "--counts-out", counts]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /total=0 run=0/);
  assert.match(result.stdout, /Empty shard/);
  assert.deepEqual(JSON.parse(readFileSync(counts, "utf8")), {
    expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0, run: 0,
  });
});

test("shard cli: all skipped exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-shard-"));
  const report = join(dir, "playwright-report.json");
  const counts = join(dir, "playwright-counts.json");
  writeFileSync(report, JSON.stringify(stats({ skipped: 7 })));
  const result = runScript(["--mode", "shard", "--report", report, "--counts-out", counts]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /skipped=7 total=7 run=0/);
  assert.match(result.stderr, /::error::Every test in this shard was skipped/);
  assert.equal(result.stdout.includes("password"), false);
  assert.equal(JSON.parse(readFileSync(counts, "utf8")).skipped, 7);
});

test("shard cli: a missing report is an empty shard and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-shard-"));
  const counts = join(dir, "playwright-counts.json");
  const result = runScript(["--mode", "shard", "--report", join(dir, "missing.json"), "--counts-out", counts]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Empty shard/);
  assert.equal(JSON.parse(readFileSync(counts, "utf8")).total, 0);
});

test("aggregate cli: run=0 across shard files fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-agg-"));
  mkdirSync(join(dir, "playwright-counts-01"));
  mkdirSync(join(dir, "playwright-counts-02"));
  writeFileSync(join(dir, "playwright-counts-01", "playwright-counts.json"), JSON.stringify(countsFromReport(stats({}))));
  writeFileSync(join(dir, "playwright-counts-02", "playwright-counts.json"), JSON.stringify(countsFromReport(stats({ skipped: 3 }))));
  const result = runScript(["--mode", "aggregate", "--dir", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Aggregate files: 2/);
  assert.match(result.stdout, /run=0/);
  assert.match(result.stderr, /::error::Nothing ran across shards/);
});

test("aggregate cli: a normal run exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-agg-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify(countsFromReport(stats({ expected: 2, skipped: 1 }))));
  writeFileSync(join(dir, "b.json"), JSON.stringify(countsFromReport(stats({}))));
  const result = runScript(["--mode", "aggregate", "--dir", dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /expected=2 unexpected=0 flaky=0 skipped=1 total=3 run=2/);
});

test("formatCounts lists every field", () => {
  assert.equal(
    formatCounts({ expected: 1, unexpected: 2, flaky: 3, skipped: 4, total: 10, run: 6 }),
    "expected=1 unexpected=2 flaky=3 skipped=4 total=10 run=6",
  );
});
