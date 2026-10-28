import assert from "node:assert/strict";
import { globSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

const modeGlob = "tests/**/*.mode.test.ts";

test("SHO-2881 keeps every per-mode test behind one automatic glob", () => {
  const defaultConfig = readFileSync("vitest.config.mts", "utf8");
  const modeConfig = readFileSync("vitest.modes.config.mts", "utf8");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const committedModeTests = globSync(modeGlob).sort();

  assert.equal(committedModeTests.length, 8, committedModeTests.join("\n"));
  assert.equal(defaultConfig.match(/tests\/\*\*\/\*\.mode\.test\.ts/g)?.length, 1);
  assert.equal(modeConfig.match(/tests\/\*\*\/\*\.mode\.test\.ts/g)?.length, 1);
  assert.equal(workflow.match(/npm run test:modes/g)?.length, 1);
  assert.equal(packageJson.scripts["test:modes"], "vitest run -c vitest.modes.config.mts");
  assert.equal(packageJson.scripts["test:crm-modes"], undefined);
  assert.equal(packageJson.scripts["test:reminder-modes"], undefined);
  assert.equal(packageJson.scripts["test:stalled-modes"], undefined);
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
