// SHO-2876: the four APL-2705 story specs APL-2466 / APL-2480 / APL-2482 / APL-2484 carried no qa:TC marker on any
// test title, so nothing in a run said which test-case id each acceptance criterion maps to. No id for these four
// stories exists in the repo or in any commit that touched them (git log --all -S'qa:TC-APL2480' is empty), so the
// marker is the repo's existing placeholder, the literal "qa:TC missing", on every title. This pins the four files
// the ticket names: the other story specs are out of scope and are not checked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STORIES = join(ROOT, "tests/e2e/stories");
export const PINNED = ["APL-2466", "APL-2480", "APL-2482", "APL-2484"];

/** The title of every `test("...")` in a spec. `test.describe("...")` is not a title and does not match. */
const TITLE = /^[ \t]*test\("([^"\n]*)"/gm;

/** Titles with no qa:TC token, as written; the empty list means every test is traceable. */
export function unmarkedTitles(source) {
  return [...source.matchAll(TITLE)].map((m) => m[1]).filter((title) => !title.includes("qa:TC"));
}

/** Per-file titles that carry no qa:TC marker, read from `dir` (default: the real stories folder). */
export function unmarkedIn(dir = STORIES, files = PINNED.map((n) => `${n}.spec.ts`)) {
  const out = [];
  for (const file of files) {
    const titles = unmarkedTitles(readFileSync(join(dir, file), "utf8"));
    if (titles.length) out.push(`${file}: ${titles.length} title(s) with no qa:TC marker -> ${titles.join(" | ")}`);
  }
  return out;
}

test("every test in the four APL-2705 story specs carries a qa:TC marker", () => {
  assert.deepEqual(
    unmarkedIn(),
    [],
    "each title must say qa:TC-<id> or, while the ids are unpublished, the literal \"qa:TC missing\" (SHO-2876)",
  );
});

test("the check names a title that has no qa:TC marker, so it cannot pass vacuously", () => {
  const SOURCE = [
    'test.describe("SHO-US-2.1 / APL-2480", () => {',
    '  test("AC1: marked qa:TC-fixture-0000", async () => {});',
    '  test("AC2: unmarked", async () => {});',
    "});",
  ].join("\n");
  assert.deepEqual(unmarkedTitles(SOURCE), ["AC2: unmarked"]);
});
