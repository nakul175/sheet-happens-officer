import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const original = "export function unused() {\n    if (already) continue;\n}\n";
const message = "AssertionError: expected [] to deeply equal [{}]\n at tests/jobs-stalled-crm.test.ts:1:1";
const report = { testResults: [{ assertionResults: ["all preserves exact world notices", "admins hides non-admin deals"].map(title => ({ title, status: "failed", failureMessages: [message] })) }] };
for (const producesReport of [false, true]) test(producesReport ? "accepts a freshly written expected-failure report and restores source" : "refuses stale valid output when the runner exits1 without a new report", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sho-m1-freshness-"));
  try {
    for (const directory of ["src/lib", "tests", "scripts/ci", "bin", "test-results/sho-2903-m1"]) mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ["stalled-m1-proof.mjs", "stalled-m1-result.mjs"]) copyFileSync(new URL(`./${file}`, import.meta.url), path.join(root, "scripts/ci", file));
    writeFileSync(path.join(root, "src/lib/deals.ts"), original);
    writeFileSync(path.join(root, "tests/jobs-stalled-crm.test.ts"), "expect(second.after).toEqual(second.before);\n");
    const old = JSON.stringify(report);
    writeFileSync(path.join(root, "test-results/sho-2903-m1/result.json"), old);
    writeFileSync(path.join(root, "valid.json"), old);
    const runner = path.join(root, "bin/npx");
    writeFileSync(runner, '#!/usr/bin/env node\n' + (producesReport ? 'const fs=require("node:fs");const file=process.argv.find(arg=>arg.startsWith("--outputFile=")).slice(13);fs.copyFileSync("valid.json",file);\n' : '') + 'process.exit(1);\n');
    chmodSync(runner, 0o755);
    const result = spawnSync(process.execPath, ["scripts/ci/stalled-m1-proof.mjs"], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`, DATABASE_URL: "postgresql://test:test@localhost/sho_test", TASKBOARD_URL: "http://localhost:3100" } });
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(path.join(root, "src/lib/deals.ts"), "utf8"), original);
    assert.equal(readFileSync(path.join(root, "test-results/sho-2903-m1/result.json"), "utf8"), old);
    const attempts = readdirSync(path.join(root, "test-results/sho-2903-m1")).filter(name => name.startsWith("attempt-"));
    assert.equal(attempts.length, 1);
    const receipt = path.join(root, "test-results/sho-2903-m1", attempts[0], "receipt.json");
    if (producesReport) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(readFileSync(receipt)).freshReport, true);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /M1 runner did not complete with expected assertion failures/);
      assert.equal(existsSync(receipt), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
