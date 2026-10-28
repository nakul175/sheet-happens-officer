// Local isolated CI only. The built server stays unchanged; Vitest loads the temporary source mutation.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { validateStalledM1 } from "./stalled-m1-result.mjs";
const local = url => ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
const database = new URL(process.env.DATABASE_URL ?? "http://refused.invalid");
const api = new URL(process.env.TASKBOARD_URL ?? "http://refused.invalid");
if (!local(database) || !/^postgres(?:ql)?:$/.test(database.protocol) || database.pathname !== "/sho_test" || !local(api) || !/^https?:$/.test(api.protocol)) throw new Error("M1 proof requires localhost API and sho_test database");
const file = "src/lib/deals.ts", source = readFileSync(file, "utf8");
const guard = "    if (already) continue;";
if (source.split(guard).length !== 2) throw new Error("M1 guard no longer unique; review mutation before running");
const parent = "test-results/sho-2903-m1";
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(`${parent}/attempt-`);
let result;
try {
  writeFileSync(file, source.replace(guard, "    if (false && already) continue; // SHO-2903 local M1 mutation"));
  result = spawnSync("npx", ["vitest", "run", "-c", "vitest.scoped4-all.config.mts", "tests/jobs-stalled-crm.test.ts", "--testNamePattern", "all preserves exact world notices|admins hides non-admin deals", "--reporter=json", `--outputFile=${dir}/result.json`], { encoding: "utf8", timeout: 180000 });
  writeFileSync(`${dir}/runner.log`, (result.stdout ?? "") + (result.stderr ?? ""));
} finally { writeFileSync(file, source); }
if (readFileSync(file, "utf8") !== source) throw new Error("M1 source restoration failed");
if (!result || result.error || result.signal || result.status !== 1 || !existsSync(`${dir}/result.json`)) throw new Error("M1 runner did not complete with expected assertion failures");
const report = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
const titles = validateStalledM1(report, readFileSync("tests/jobs-stalled-crm.test.ts", "utf8"));
writeFileSync(`${dir}/receipt.json`, JSON.stringify({ mutation: "already-notified check removed", baseline: "required full Unit tests step precedes this proof", detection: titles, assertionFailures: 2, sourceRestored: true, attemptDirectory: dir, freshReport: true }, null, 2) + "\n");
console.log("SHO-2903 M1 detected by all/admins exact-row assertions; source restored");
