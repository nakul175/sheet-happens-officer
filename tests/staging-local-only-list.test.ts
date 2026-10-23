// The staging-regression summary prints which tests it excludes. The tags are the source of truth: every test tagged
// @local-only is left out of that run, so every one of them has to be named in the printed list. This is a file read,
// like the other @static checks: no server, model or database.
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

/** The printed list as one sentence, joined from the `echo` lines the summary block writes. */
function printed(): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("**Excluded (@local-only):**"));
  expect(start, "the summary prints an @local-only exclusion list").toBeGreaterThan(-1);
  const said: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes("Also excluded")) break;
    said.push(lines[i].replace(/^\s*echo\s+"/, "").replace(/"\s*$/, ""));
  }
  return said.join(" ");
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
