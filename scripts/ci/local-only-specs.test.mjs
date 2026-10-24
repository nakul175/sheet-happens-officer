// SHO-3000 AC1: the printed @local-only exclusion list must match every test tagged @local-only, ideally by derivation.
// The previous list was a hand-written line in .github/workflows/staging-regression.yml and it named 4 of the 8 tagged
// specs. These checks read the tags, read the workflow, and fail when the two disagree or when the line goes back to
// being hand-written.
//
// AC2 (the exclusion behaviour itself is unchanged) is checked here too: the suite still runs with --grep-invert over
// EXCLUDED_TAGS, and that tag set still holds @local-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labels, labelsIn, localOnlyFiles, summaryLine, STORIES } from "./local-only-specs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/staging-regression.yml"), "utf8");
/** The "Write the summary" step's body, up to the next step. */
const SUMMARY_STEP = WORKFLOW.split("- name: Write the summary")[1].split("- name: Upload the counts")[0];

// SHO-2882: staging-e2e collects the spec files itself, so the exclusion has to happen there too -- --grep-invert only
// filters tests inside the files it is given.
const E2E = readFileSync(join(ROOT, ".github/workflows/staging-e2e.yml"), "utf8");
/** The plan job's "Split them into parallel and serial" step, up to the next step. */
const PICK_STEP = (E2E.split("- name: Split them into parallel and serial")[1] ?? "").split("- uses: actions/setup-node")[0];
/** The serial spec ids the workflow names. */
const SERIAL_IDS = (E2E.split("SERIAL_SPECS: >-")[1] ?? "").split("jobs:")[0].trim().split(/\s+/).filter(Boolean);

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

test("the workflow keeps no hand-written copy of the tagged list (SHO-2996)", () => {
  // The printed line is derived, but the header still wrote the eight specs out by hand ("the tagged specs are
  // APL-2471 AC4, APL-2609, ..."), which is a second copy of exactly the list this module derives. It matched on the
  // day and nothing would have noticed it going stale: a ninth tagged spec changes the printed line and not the
  // comment. Derivation means one copy, so the sentence is gone rather than kept in step by eye.
  assert.doesNotMatch(WORKFLOW, /tagged specs are APL-\d+/);
});

test("the exclusion behaviour is unchanged (SHO-3000 AC2)", () => {
  assert.match(WORKFLOW, /EXCLUDED_TAGS: "@local-only\|@static\|@manual"/);
  assert.match(WORKFLOW, /npx playwright test --workers=1 --grep-invert "\$EXCLUDED_TAGS"/);
});

test("SHO-2882 AC1: only a whole-spec tag names a file the staging collection must leave out", () => {
  const files = localOnlyFiles();
  assert.deepEqual(files, [
    "APL-2609.spec.ts",
    "APL-2624.spec.ts",
    "APL-2669.spec.ts",
    "APL-2674.spec.ts",
    "APL-2721.spec.ts",
    "APL-2737.spec.ts",
    "APL-2742.spec.ts",
  ]);
  // APL-2471 carries the tag on AC4 alone; its other tests do run on staging, so the file stays in the collection and
  // only the one test is left to --grep-invert.
  assert.ok(!files.includes("APL-2471.spec.ts"), "a one-test tag must not remove the whole file");
  for (const file of files) {
    assert.ok(labels().includes(file.slice(0, -".spec.ts".length)), `${file} is not a whole-file label`);
  }
});

test("SHO-2882 AC2: the workflow takes that list from the tags and filters the collection with it", () => {
  assert.match(PICK_STEP, /local_only=\$\(node scripts\/ci\/local-only-specs\.mjs --files\)/);
  assert.match(PICK_STEP, /is_local_only\(\) \{ \[\[ " \$local_only " == \*" \$\(basename "\$1"\) "\* \]\]/);
  // Both ways a file becomes part of the run consult it: an issue id or glob, and the empty-input sweep.
  assert.match(PICK_STEP, /elif is_local_only "\$f"; then local_hit\+=\("\$f"\)/);
  assert.match(PICK_STEP, /is_vitest "\$f" \|\| is_local_only "\$f" \|\| files\+=\("\$f"\)/);
  // A token that names only local-only specs is an error, not a run that ends in "No tests found".
  assert.match(PICK_STEP, /selects only @local-only story specs/);
  // The command the step runs prints exactly the files this test derives.
  const printed = execFileSync(process.execPath, ["scripts/ci/local-only-specs.mjs", "--files"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.deepEqual(printed.split(" "), localOnlyFiles());
});

test("SHO-2882 AC3: no @local-only spec is named as a serial spec", () => {
  assert.ok(SERIAL_IDS.length > 0, "SERIAL_SPECS was not found in staging-e2e.yml");
  // APL-2609 was on this list and is tagged @local-only: the serial job ran one file and got "Error: No tests found."
  const offenders = SERIAL_IDS.filter((id) => localOnlyFiles().includes(`${id}.spec.ts`));
  assert.deepEqual(offenders, [], "a local-only spec in SERIAL_SPECS leaves the serial job with no tests");
});
