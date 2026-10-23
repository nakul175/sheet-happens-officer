// SHO-2996 / SHO-2997 / SHO-2998 AC1: a parent step, `.locator("..")`, names nothing and breaks when a wrapper element
// is added around the element it starts from. Line 18 of APL-2539.spec.ts, line 44 of APL-2540.spec.ts (AC1's deal panel)
// and line 118 of APL-2540.spec.ts (AC4's parties line) each had one. Those three call sites were rewritten to role
// locators, but the same parent-walk survived in the shared helper APL-2540 AC3 still calls, so the spec could go red on a
// wrapper change without any of the fixed lines changing.
//
// This check is the guard for all three: no story spec, and no locator helper those deal specs use, may go back to one.
// tests/e2e/helpers/screen-row.ts is deliberately out of scope: its activityRow() walks up from a sentence to its row and
// is used by APL-2470/2504/2505, which no ticket in this cluster touches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STORIES = join(ROOT, "tests/e2e/stories");
const HELPERS = ["tests/e2e/helpers/claude-a.ts"];

/** `.locator("..")` and `.locator('..')`, the whole-string parent step only: `"../x"` module paths are untouched. */
const PARENT_STEP = /\.locator\(\s*["'`]\.\.["'`]\s*\)/;

function files() {
  const stories = readdirSync(STORIES).filter((n) => n.endsWith(".spec.ts")).map((n) => join(STORIES, n));
  return [...stories, ...HELPERS.map((p) => join(ROOT, p))];
}

test("no story spec or deal helper walks to a parent element", () => {
  const offenders = [];
  for (const file of files()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!/^\s*(\/\/|\*)/.test(line) && PARENT_STEP.test(line)) offenders.push(`${file.replace(`${ROOT}/`, "")}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use a role, test-id or label locator instead of a parent step");
});

test("the deal panel APL-2540 AC1 and AC3 share is the one that holds the Stage group", () => {
  const helper = readFileSync(join(ROOT, "tests/e2e/helpers/claude-a.ts"), "utf8");
  assert.match(helper, /export const dealPanel = \(page: Page\) => page\.getByRole\("main"\)\.filter\(\{ has: page\.getByRole\("group", \{ name: "Stage" \}\) \}\)/);
});
