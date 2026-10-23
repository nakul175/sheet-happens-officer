// SHO-2917, independent review (w41). REVIEW-2917 F1/F2 were closed only for the spellings the finding named; the two
// further classes this file pinned (a wrapper in front of the dump, the process object handed out by a namespace import,
// a require() alias or a dynamic import) were left as `it.fails`. W239 closed them in the guard and PROMOTED every pin
// below to a plain `it`, exactly as this file's header prescribed: `it.fails` would now be red because the guard catches
// them. tests/base-url-no-environ-dump.test.ts:1076-1114 carries the same shapes as the guard's own W239 block, plus the
// wrapper operand (`sudo -u root env`, `timeout 10 env`) and the bound script the promotion made reachable.
// The route strings are data, never calls: the AC1 tree scan parses this file as source and stays green (checked by
// running base-url-no-environ-dump.test.ts, which scans every file under tests/ including this one).
import { describe, expect, it } from "vitest";
import { violations } from "./base-url-no-environ-dump.test";

/** The forms the one authoritative guard reports for a single file of source. */
const forms = (text: string) => violations([{ file: "x.test.ts", text }]).map(({ form }) => form);

describe("w41 OPEN GAPS: routes REVIEW-2917 F1/F2 claim to cover and the guard now catches", () => {
  it("the harness is live: a bare printenv is reported", () => {
    expect(forms(`execSync("printenv");`)).toEqual(["environment printed by a child process"]);
  });

  // F1's model read words[0] of each shell segment (base-url-no-environ-dump.test.ts), so a wrapper program in front of
  // the dump hid it. `nohup printenv` prints exactly what `printenv` prints; W239 strips the wrapper.
  for (const [label, text] of [
    ["a nohup prefix", `execSync("nohup printenv");`],
    ["a sudo prefix", `execSync("sudo env");`],
    ["an xargs prefix", `execSync("xargs env");`],
  ] as const) {
    it(`w41 CLOSED by W239: F1 catches ${label} in front of the dump`, () => {
      expect(forms(text).length).toBeGreaterThan(0);
    });
  }

  // The F3 boundary (a name instead of a literal) applies to F1's command line too: commandLines() resolves a name bound
  // to a literal in the same file, so the command is read as the text it is.
  it("w41 CLOSED by W239: F1/F3 read a command name bound on the line before", () => {
    expect(forms(`const CMD = "printenv";\nexecSync(CMD);`).length).toBeGreaterThan(0);
  });

  // F2 reports `import { env } from "node:process"`, `const { env } = process` and `require("node:process").env`. The
  // namespace import, a require() alias and a dynamic import hand out the same object; W239 binds them to `process`.
  for (const [label, text] of [
    ["a namespace import spread", `import * as p from "node:process";\nconst copy = { ...p.env };`],
    ["a namespace import dump", `import * as p from "node:process";\nconsole.log(p.env);`],
    ["an alias of require()", `const p = require("node:process");\nconsole.log(p.env);`],
    ["a dynamic import", `const p = await import("node:process");\nconsole.log(p.env);`],
  ] as const) {
    it(`w41 CLOSED by W239: F2 catches ${label}`, () => {
      expect(forms(text).length).toBeGreaterThan(0);
    });
  }

  // The pins above are positives; a text ban would also catch these, which are not dumps. None of them is reported.
  it("w41 CLOSED by W239: the closed routes did not become a text ban", () => {
    for (const text of [
      `execSync("grep env notes.txt");`,
      `execSync("sudo tee env");`,
      `execSync("timeout 10 npm test");`,
      `const CMD = "git"; execSync(CMD);`,
      `import * as p from "node:process"; console.log(p.version);`,
    ]) {
      expect(forms(text), text).toEqual([]);
    }
  });
});

