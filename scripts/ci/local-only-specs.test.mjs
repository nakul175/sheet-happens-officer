// SHO-3000 AC1: the printed @local-only exclusion list must match every test tagged @local-only, ideally by derivation.
// The previous list was a hand-written line in .github/workflows/staging-regression.yml and it named 4 of the 8 tagged
// specs. These checks read the tags, read the workflow, and fail when the two disagree or when the line goes back to
// being hand-written.
//
// AC2 (the exclusion behaviour itself is unchanged) is checked here too: the suite still runs with --grep-invert over
// EXCLUDED_TAGS, and that tag set still holds @local-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labels, labelsIn, summaryLine, STORIES } from "./local-only-specs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/staging-regression.yml"), "utf8");
/** The "Write the summary" step's body, up to the next step. */
const SUMMARY_STEP = WORKFLOW.split("- name: Write the summary")[1].split("- name: Upload the counts")[0];

test("a describe tag, a tagged title and a comment mention are told apart", () => {
  const source = [
    "// @local-only: the header explains the tag but is not one (APL-2742 does this).",
    'test.describe("x", { tag: "@local-only" }, () => {',
    'test("AC4: a reminder @local-only", async () => {});',
    'test("AC5: no tag here", async () => {});',
    'test.describe("y", { tag: "@manual" }, () => {});',
  ].join("\n");
  assert.deepEqual(labelsIn("APL-9999", source).sort(), ["APL-9999", "APL-9999 AC4"].sort());
});

test("the tag list comes from the story files, not from a list of ids", () => {
  const all = labels();
  assert.ok(all.length > 0, "no @local-only spec found; the extractor or the directory moved");
  // The four the hand-written line knew, plus the four it did not.
  for (const label of ["APL-2471 AC4", "APL-2609", "APL-2624", "APL-2669", "APL-2674", "APL-2721", "APL-2737", "APL-2742"]) {
    assert.ok(all.includes(label), `${label} is tagged @local-only but was not found`);
  }
  // Every label names a real story file: no label can outlive the spec it came from.
  for (const label of all) {
    const id = label.split(" ")[0];
    assert.doesNotThrow(() => readFileSync(join(STORIES, `${id}.spec.ts`), "utf8"), `${label} has no spec file`);
  }
});

test("the printed summary lists every @local-only spec and nothing else (SHO-3000 AC1)", () => {
  const line = summaryLine();
  assert.match(line, /^\*\*Excluded \(@local-only\):\*\* /);
  const printed = line.replace(/^\*\*Excluded \(@local-only\):\*\* /, "").replace(/\.$/, "").split(", ");
  assert.deepEqual(printed, labels(), "the printed exclusion list and the tags disagree");
});

test("the summary derives its list instead of hard-coding it", () => {
  assert.match(SUMMARY_STEP, /node scripts\/ci\/local-only-specs\.mjs --summary/);
  assert.doesNotMatch(SUMMARY_STEP, /APL-\d+ AC?\d*,\s*APL-/, "the summary step still hard-codes a spec list");
});

test("the exclusion behaviour is unchanged (SHO-3000 AC2)", () => {
  assert.match(WORKFLOW, /EXCLUDED_TAGS: "@local-only\|@static\|@manual"/);
  assert.match(WORKFLOW, /npx playwright test --workers=1 --grep-invert "\$EXCLUDED_TAGS"/);
});
