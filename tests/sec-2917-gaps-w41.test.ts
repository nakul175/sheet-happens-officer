// SHO-2917, independent review (w41). REVIEW-2917 F1/F2 are CLOSED for the spellings the finding named — the committed
// tests in sec-2917-gaps.test.ts are RED against the pre-W12 guard and GREEN here — but the CLASS is not exhausted: two
// spellings of the same defect still pass the guard silently. Each case below is `it.fails`: it passes while the guard
// misses the route and turns RED on the day the route is caught, which is the signal to promote it to a plain `it` and
// cite the fix. Nothing here is asserted as correct behaviour, and the guard is not weakened.
// The route strings are data, never calls: the AC1 tree scan parses this file as source and stays green (checked by
// running base-url-no-environ-dump.test.ts, which scans every file under tests/ including this one).
//
// OWNERSHIP (w281, 24 Oct 2026; the tracker was read only, nothing there was changed). Eight runtime cases below, none
// owned by a ticket: each site says NO-TICKET and names the nearest ticket and why it does not match. The near tickets
// all come from Pam's QA of PR #149 on SHO-2917. SHO-3031 is the AC3 guard's FALSE POSITIVE -- Expected "The file is not
// flagged, because it never builds a `/proc/<pid|self>/environ` path", Actual "The proc check works at file level ...
// so the guard fails (false positive)" -- which is the opposite direction from a miss. SHO-3032 is the guard MISSING A
// MID-WORD SPLIT of that path -- Expected "The guard flags the file, because it assembles" that path, Actual "The scan
// matches only whole `proc`/`environ` path pieces, so mid-word splits escape it and the test passes". SHO-2917's own
// AC3 reads "a test or lint check fails if any test file under tests/ reads" that same path. Not one row below builds or
// reads that path: every row hands the environment to a child process or binds the process object, so no quoted
// sentence covers it. Decisive: both 3031 and 3032 are fixed in this tree and asserted green at
// tests/no-proc-environ-2917.test.ts:366 and :381, and all eight pins below still miss against that fixed guard -- their
// fix demonstrably does not reach these spellings. The pins stay exactly as they are: nothing asserted was weakened and
// no `it.fails` became an `it`.
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
  // NO-TICKET (three runtime cases: nohup, sudo, xargs). Nearest is SHO-3032, and it does not match: its Expected is
  // "The guard flags the file, because it assembles" the process-image path, a scan these rows never enter, and its fix
  // is already in and green (:381 of no-proc-environ-2917) while all three still miss. SHO-3031 is a false positive on
  // that same path -- the opposite direction. SHO-2917 AC3 is a read of that path, not a child process printing the
  // environment. Pin kept: the guard still misses a wrapper in front of the dump.
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
  // NO-TICKET. The only record of this spelling anywhere is the disposition id SEC-2917-F3 (SEC-2917-F3-DISPOSITION.md:
  // status DEFERRED, "blocking: nothing"), which is a document, not a ticket, and whose acceptance criterion is a
  // different shape (a helper that logs its argument). SHO-3032's Expected sentence is the process-image path again, not
  // a command name bound on the line before. Pin kept.
  it.fails("w41 OPEN: F1/F3 miss a command name bound on the line before", () => {
    expect(forms(`const CMD = "printenv";\nexecSync(CMD);`).length).toBeGreaterThan(0);
  });

  // F2 reports `import { env } from "node:process"`, `const { env } = process` and `require("node:process").env`. The
  // namespace import and an alias of the require result hand out the same object and are not reported.
  // NO-TICKET (four runtime cases: a namespace import spread, a namespace import dump, an alias of require(), a dynamic
  // import). Neither near ticket matches: SHO-3031 ("it never builds a `/proc/<pid|self>/environ` path") and SHO-3032
  // (the mid-word split of that path) both judge that one path, and a namespace import of node:process is not it; both
  // are fixed and green at :366/:381 of no-proc-environ-2917 while these four still miss. SHO-2917 AC3 is a read of that
  // path. Pin kept.
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
