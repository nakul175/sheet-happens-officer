import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHARD_ACCOUNTS,
  clampShardCount,
  matchingTestsFromList,
  shardMatrix,
} from "./clamp-shards.mjs";

const script = fileURLToPath(new URL("./clamp-shards.mjs", import.meta.url));

test("clamp is min(requested, matching) and at least 1", () => {
  assert.equal(clampShardCount(20, 92), 20);
  assert.equal(clampShardCount(20, 20), 20);
  assert.equal(clampShardCount(20, 7), 7);
  assert.equal(clampShardCount(20, 1), 1);
  assert.equal(clampShardCount(5, 100), 5);
  assert.equal(clampShardCount(1, 4), 1);
});

test("zero matching tests still schedules one shard", () => {
  assert.equal(clampShardCount(20, 0), 1);
  assert.equal(shardMatrix(clampShardCount(20, 0)).length, 1);
  assert.deepEqual(shardMatrix(1).map((row) => row.shard), [1]);
});

test("a run with fewer tests than shards does not keep empty shard indexes", () => {
  const count = clampShardCount(20, 3);
  const matrix = shardMatrix(count);
  assert.equal(matrix.length, 3);
  assert.deepEqual(matrix.map((row) => row.shard), [1, 2, 3]);
});

test("the full account table is the requested maximum of 20", () => {
  assert.equal(SHARD_ACCOUNTS.length, 20);
  assert.equal(shardMatrix(clampShardCount(20, 100)).length, 20);
  assert.equal(shardMatrix(20)[0].nn, "01");
  assert.equal(shardMatrix(20)[19].nn, "20");
});

test("list output total is the matching count", () => {
  const listed = [
    "Listing tests:",
    "  [chromium] › tests/e2e/stories/APL-2465.spec.ts:12:5 › AC1",
    "  [chromium] › tests/e2e/stories/APL-2465.spec.ts:20:5 › AC2",
    "Total: 2 tests in 1 file",
  ].join("\n");
  assert.equal(matchingTestsFromList(listed, 0), 2);
  assert.equal(matchingTestsFromList("Total: 1 test in 1 file\n", 0), 1);
  assert.equal(matchingTestsFromList("Total: 0 tests in 0 files\n", 0), 0);
});

test("No tests found counts as zero matches", () => {
  const text = "Error: No tests found.\nMake sure that arguments are regular expressions matching test files.\n";
  assert.equal(matchingTestsFromList(text, 1), 0);
});

test("any other list failure is not treated as zero tests", () => {
  assert.throws(() => matchingTestsFromList("Error: Cannot find module './missing'\n", 1), /playwright test --list failed/);
  assert.throws(() => matchingTestsFromList("Listing tests:\n", 0), /did not report a Total line/);
});

test("the cli writes the clamped matrix for github output", () => {
  const dir = mkdtempSync(join(tmpdir(), "clamp-shards-"));
  const list = join(dir, "list.txt");
  const output = join(dir, "github-output.txt");
  writeFileSync(list, "Listing tests:\nTotal: 4 tests in 2 files\n");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [
    script,
    "--requested", "20",
    "--status", "0",
    "--list", list,
    "--github-output", output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Matching tests: 4/);
  assert.match(result.stdout, /Shard count: 4/);
  const written = readFileSync(output, "utf8");
  assert.match(written, /^matching=4$/m);
  assert.match(written, /^total=4$/m);
  const matrixLine = written.split("\n").find((line) => line.startsWith("matrix="));
  const matrix = JSON.parse(matrixLine.slice("matrix=".length));
  assert.equal(matrix.length, 4);
  assert.deepEqual(matrix.map((row) => row.shard), [1, 2, 3, 4]);
});
