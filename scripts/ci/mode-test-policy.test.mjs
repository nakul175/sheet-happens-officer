import assert from "node:assert/strict";
import { globSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

const modeGlob = "tests/**/*.mode.test.ts";
const migratedModeTests = [
  "tests/apl-2713-crm-modes.mode.test.ts",
  "tests/crm-visible-modes-server.mode.test.ts",
  "tests/e2e/local/APL-2609.mode.test.ts",
  "tests/e2e/local/APL-2728.mode.test.ts",
  "tests/e2e/local/APL-2735.mode.test.ts",
  "tests/jobs-reminders-crm-server.mode.test.ts",
  "tests/jobs-stalled-crm-server.mode.test.ts",
  "tests/task-outsider-2875-crm.mode.test.ts",
];

test("SHO-2881 keeps every per-mode test behind one automatic glob", () => {
  const defaultConfig = readFileSync("vitest.config.mts", "utf8");
  const modeConfig = readFileSync("vitest.modes.config.mts", "utf8");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const committedModeTests = globSync(modeGlob).sort();

  assert.deepEqual(
    migratedModeTests.filter((path) => !committedModeTests.includes(path)),
    [],
    `migrated mode tests dropped from the glob:\n${committedModeTests.join("\n")}`,
  );
  assert.equal(defaultConfig.match(/tests\/\*\*\/\*\.mode\.test\.ts/g)?.length, 1);
  assert.equal(modeConfig.match(/tests\/\*\*\/\*\.mode\.test\.ts/g)?.length, 1);
  assert.equal(workflow.match(/npm run test:modes/g)?.length, 1);
  assert.equal(packageJson.scripts["test:modes"], "vitest run -c vitest.modes.config.mts");
  assert.equal(packageJson.scripts["test:crm-modes"], undefined);
  assert.equal(packageJson.scripts["test:reminder-modes"], undefined);
  assert.equal(packageJson.scripts["test:stalled-modes"], undefined);
});

test("SHO-2881 readers open the renamed mode files", () => {
  const seed = readFileSync("tests/crm-mode-seed-api.test.ts", "utf8");
  const reminders = readFileSync("tests/reminder-cleanup-2751.test.ts", "utf8");
  assert.match(seed, /crm-visible-modes-server\.mode\.test\.ts/);
  assert.doesNotMatch(seed, /crm-visible-modes-server\.test\.ts/);
  assert.match(reminders, /jobs-reminders-crm-server\.mode\.test\.ts/);
  assert.doesNotMatch(reminders, /jobs-reminders-crm-server\.test\.ts/);
});

test("SHO-2881 automatically collects a newly added per-mode test", () => {
  const scratch = "tests/sho-2881-scratch.mode.test.ts";
  writeFileSync(scratch, "// collection-only scratch file\n", { flag: "wx" });
  try {
    assert.ok(globSync(modeGlob).includes(scratch));
  } finally {
    unlinkSync(scratch);
  }
});
