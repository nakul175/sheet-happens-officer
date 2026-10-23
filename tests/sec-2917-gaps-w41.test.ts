// SHO-2917, independent review (w41). REVIEW-2917 F1/F2 are CLOSED for the spellings the finding named — the committed
// tests in sec-2917-gaps.test.ts are RED against the pre-W12 guard and GREEN here — but the CLASS is not exhausted: two
// spellings of the same defect still pass the guard silently. Each case below is `it.fails`: it passes while the guard
// misses the route and turns RED on the day the route is caught, which is the signal to promote it to a plain `it` and
// cite the fix. Nothing here is asserted as correct behaviour, and the guard is not weakened.
// The route strings are data, never calls: the AC1 tree scan parses this file as source and stays green (checked by
// running base-url-no-environ-dump.test.ts, which scans every file under tests/ including this one).
import { describe, expect, it } from "vitest";
import { violations } from "./base-url-no-environ-dump.test";

/** The forms the one authoritative guard reports for a single file of source. */
const forms = (text: string) => violations([{ file: "x.test.ts", text }]).map(({ form }) => form);

describe("w41 OPEN GAPS: routes REVIEW-2917 F1/F2 claim to cover but the guard still misses", () => {
  it("the harness is live: a bare printenv is reported", () => {
    expect(forms(`execSync("printenv");`)).toEqual(["environment printed by a child process"]);
  });

  // F1's model reads words[0] of each shell segment (base-url-no-environ-dump.test.ts:80-89), so a wrapper program in
  // front of the dump hides it. `nohup printenv` prints exactly what `printenv` prints.
  for (const [label, text] of [
    ["a nohup prefix", `execSync("nohup printenv");`],
    ["a sudo prefix", `execSync("sudo env");`],
    ["an xargs prefix", `execSync("xargs env");`],
  ] as const) {
    it.fails(`w41 OPEN: F1 misses ${label} in front of the dump`, () => {
      expect(forms(text).length).toBeGreaterThan(0);
    });
  }

  // The F3 boundary (a name instead of a literal) applies to F1's command line too: commandLines() returns null for a
  // computed command (:95-99). So F1's closure depends on F3 for this spelling.
  it.fails("w41 OPEN: F1/F3 miss a command name bound on the line before", () => {
    expect(forms(`const CMD = "printenv";\nexecSync(CMD);`).length).toBeGreaterThan(0);
  });

  // F2 reports `import { env } from "node:process"`, `const { env } = process` and `require("node:process").env`. The
  // namespace import and an alias of the require result hand out the same object and are not reported.
  for (const [label, text] of [
    ["a namespace import spread", `import * as p from "node:process";\nconst copy = { ...p.env };`],
    ["a namespace import dump", `import * as p from "node:process";\nconsole.log(p.env);`],
    ["an alias of require()", `const p = require("node:process");\nconsole.log(p.env);`],
    ["a dynamic import", `const p = await import("node:process");\nconsole.log(p.env);`],
  ] as const) {
    it.fails(`w41 OPEN: F2 misses ${label}`, () => {
      expect(forms(text).length).toBeGreaterThan(0);
    });
  }
});
