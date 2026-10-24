// The staging-regression summary prints which tests it excludes. The tags are the source of truth: every test tagged
// @local-only is left out of that run, so every one of them has to be named in the printed list. This is a file read
// plus one local command, like the other @static checks: no server, model or database.
//
// SHO-3000: the list is no longer written by hand in the workflow's echo lines -- a hand-written line named 4 of the 8
// tagged specs -- so the check runs the command the summary step runs (scripts/ci/local-only-specs.mjs --summary) and
// compares what it prints with the tags read here. The two tag scans are separate, so one of them missing a tag shows.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = path.join(process.cwd(), ".github/workflows/staging-regression.yml");
const STORIES = path.join(process.cwd(), "tests/e2e/stories");

/**
 * The tests the run leaves out, one label each: `<APL>` when a whole spec is tagged (a tagged describe) and
 * `<APL> AC<n>` when the tag sits on one test in a spec that otherwise runs.
 */
function tagged(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(STORIES).filter((f) => f.endsWith(".spec.ts"))) {
    const spec = file.replace(/\.spec\.ts$/, "");
    for (const line of readFileSync(path.join(STORIES, file), "utf8").split("\n")) {
      if (!line.includes("@local-only") || line.trimStart().startsWith("//")) continue;
      const ac = line.match(/\bAC\d+\b/)?.[0];
      out.push(/test\.describe\(/.test(line) || !ac ? spec : `${spec} ${ac}`);
    }
  }
  return out.sort();
}

/** The printed list as the summary step produces it: it runs the command, and this reads the command's output. */
function printed(): string {
  const step = readFileSync(WORKFLOW, "utf8").split("- name: Write the summary")[1]?.split("- name: Upload the counts")[0] ?? "";
  expect(step, "the summary step derives the @local-only list").toMatch(/node scripts\/ci\/local-only-specs\.mjs --summary/);
  return execFileSync(process.execPath, ["scripts/ci/local-only-specs.mjs", "--summary"], { cwd: process.cwd(), encoding: "utf8" });
}

describe("qa:TC missing the staging-regression @local-only exclusion list", () => {
  it("AC1: the printed list names every test tagged @local-only", () => {
    const want = tagged();
    expect(want.length).toBeGreaterThan(0);
    const text = printed();
    const missing = want.filter((label) => !new RegExp(`\\b${label}\\b`).test(text));
    expect(missing, "tagged @local-only but not named in the summary").toEqual([]);
  });

  it("AC1: a spec tagged only on one test is named with that test, not as a whole spec", () => {
    // APL-2471 carries the tag on AC4 alone; AC1-AC3, AC5-AC7 do run on staging.
    expect(printed()).toMatch(/\bAPL-2471 AC4\b/);
    expect(printed()).not.toMatch(/\bAPL-2471\b(?! AC\d)/);
  });
});
