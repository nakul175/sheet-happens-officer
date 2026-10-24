// SHO-2752 (APL-2739 follow-up, the UNTESTED verdict on #108). Two defects in the APL-2739 tests:
//
// 1. Naming. tests/apl-2739.test.ts creates people, an organisation and a deal through the app's API, so the
//    rows stay in the server's database. Every other database-backed test names them ZZ-TEST, so QA and the
//    cleanup can tell them from real data (tests/helpers.ts zzProject, tests/zz-test-data.ts, tests/apl-2736.test.ts).
//    It wrote `Org 2739 …`, `Deal 2739 …` and `account("rf2739seed")` instead.
// 2. Self-check. tests/e2e/local/APL-2739.test.ts runs a real Chromium, so vitest.config.mts excludes it from
//    `npm test` (:54) and vitest.browser-tier.config.mts collects it (`npm run test:browser`, :15). Its header
//    named neither, and its describe title said the stage "lists empty required fields" while the fixture lists
//    value and currency. Both sentences are what a reviewer checks itself against, so both are pinned here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const INTEGRATION = "tests/apl-2739.test.ts";
const SPEC = "tests/e2e/local/APL-2739.test.ts";

/** Every display name this file gives a person, an organisation or a deal. */
export function fixtureNames(source: string) {
  const names: string[] = [];
  for (const m of source.matchAll(/\bname:\s*`([^`]*)`/g)) names.push(m[1]);
  for (const m of source.matchAll(/\baccount\(\s*[`"]([^`"]*)/g)) names.push(m[1]);
  return names;
}

/** The describe title of the one story in `source`. */
export function describeTitle(source: string) {
  const line = source.split("\n").find((l) => l.trimStart().startsWith("describe("));
  return line?.match(/describe\(\s*"([^"]*)"/)?.[1] ?? "";
}

describe("SHO-2752: the APL-2739 tests name their data and their run", () => {
  it("names every person, organisation and deal it leaves behind ZZ-TEST (qa:TC missing)", () => {
    const source = read(INTEGRATION);
    const names = fixtureNames(source);
    // The file really is read: an empty list would make the check below pass for nothing.
    expect(names.length, `fixtures found in ${INTEGRATION}`).toBeGreaterThanOrEqual(3);
    expect(names.filter((n) => !n.startsWith("ZZ-TEST")), `a ZZ-TEST prefix on every fixture name in ${INTEGRATION}`).toEqual([]);
  });

  it("says which npm script collects the browser-tier spec, because npm test does not (qa:TC missing)", () => {
    const header = read(SPEC).split("\n").slice(0, 8).join("\n");
    expect(read("vitest.config.mts"), `${SPEC} is excluded from npm test`).toContain(`"${SPEC}"`);
    expect(read("vitest.browser-tier.config.mts"), `${SPEC} is collected by the browser tier`).toContain(`"${SPEC}"`);
    expect(header, `the header of ${SPEC} names the script that runs it`).toContain("npm run test:browser");
  });

  it("titles the story after what the stage requires, not after an empty list (qa:TC missing)", () => {
    const title = describeTitle(read(SPEC));
    expect(title, `the describe title in ${SPEC}`).toContain("requires value and currency");
    expect(title).not.toContain("empty required fields");
  });
});
