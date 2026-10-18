// Shard count for staging e2e. Never schedule more shards than tests, and never
// schedule zero shards: zero matches still runs one shard so the all-skipped guard can fail the job.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// nn is the ZZ_TEST_NN account. peer is the partner of the other role
// (shard N with N+5, members with 01-05), so no two of any 5 consecutive shards share an account.
export const SHARD_ACCOUNTS = [
  { shard: 1, nn: "01", role: "ADMIN", peer: "06" },
  { shard: 2, nn: "02", role: "ADMIN", peer: "07" },
  { shard: 3, nn: "03", role: "ADMIN", peer: "08" },
  { shard: 4, nn: "04", role: "ADMIN", peer: "09" },
  { shard: 5, nn: "05", role: "ADMIN", peer: "10" },
  { shard: 6, nn: "06", role: "MEMBER", peer: "01" },
  { shard: 7, nn: "07", role: "MEMBER", peer: "02" },
  { shard: 8, nn: "08", role: "MEMBER", peer: "03" },
  { shard: 9, nn: "09", role: "MEMBER", peer: "04" },
  { shard: 10, nn: "10", role: "MEMBER", peer: "05" },
  { shard: 11, nn: "11", role: "MEMBER", peer: "01" },
  { shard: 12, nn: "12", role: "MEMBER", peer: "02" },
  { shard: 13, nn: "13", role: "MEMBER", peer: "03" },
  { shard: 14, nn: "14", role: "MEMBER", peer: "04" },
  { shard: 15, nn: "15", role: "MEMBER", peer: "05" },
  { shard: 16, nn: "16", role: "MEMBER", peer: "01" },
  { shard: 17, nn: "17", role: "MEMBER", peer: "02" },
  { shard: 18, nn: "18", role: "MEMBER", peer: "03" },
  { shard: 19, nn: "19", role: "MEMBER", peer: "04" },
  { shard: 20, nn: "20", role: "MEMBER", peer: "05" },
];

function whole(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** max(1, min(requested shards, matching tests)). Zero matches still returns 1. */
export function clampShardCount(requested, matching) {
  return Math.max(1, Math.min(whole(requested), whole(matching)));
}

/** First `count` account rows. Shard numbers stay 1..count, so Playwright gives every shard a test when any test matched. */
export function shardMatrix(count) {
  if (count < 1 || count > SHARD_ACCOUNTS.length) {
    throw new Error(`Shard count ${count} is outside 1..${SHARD_ACCOUNTS.length}.`);
  }
  return SHARD_ACCOUNTS.slice(0, count);
}

const TOTAL_LINE = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?\s*$/m;

/** Test count from `npx playwright test --list`. A "No tests found" failure counts as 0. Any other failure throws. */
export function matchingTestsFromList(output, exitCode) {
  const text = String(output ?? "");
  const total = text.match(TOTAL_LINE);
  if (total) return Number(total[1]);
  if (Number(exitCode) !== 0 && /No tests found/.test(text)) return 0;
  if (Number(exitCode) !== 0) {
    throw new Error("playwright test --list failed.");
  }
  throw new Error("playwright test --list did not report a Total line.");
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`Missing ${name}.`);
  }
  return process.argv[index + 1];
}

function main() {
  const requested = arg("--requested");
  const status = arg("--status");
  const listPath = arg("--list");
  const githubOutput = arg("--github-output");
  const matching = matchingTestsFromList(readFileSync(listPath, "utf8"), status);
  const total = clampShardCount(requested, matching);
  const matrix = shardMatrix(total);
  console.log(`Matching tests: ${matching}`);
  console.log(`Requested shards: ${whole(requested)}`);
  console.log(`Shard count: ${total}`);
  if (matching === 0) {
    console.log("No tests matched. One shard will run so the all-skipped guard can fail the job.");
  }
  appendFileSync(githubOutput, `matching=${matching}\ntotal=${total}\nmatrix=${JSON.stringify(matrix)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
