/**
 * SHO-2917 (W256): the spellings W239 did NOT test, run against the same one authoritative scanner.
 *
 * W239 closed eight unpinned spellings (wrapper programs, a command name bound to one literal, the process-object
 * aliases, and a template whose span IS the environment) and wrote a LIMITS block for what a text scanner cannot reach.
 * These cases are the review's attack on that closure: each is a spelling the environment can still be printed by
 * without the words "env"/"printenv" appearing anywhere in the file's text.
 *
 * Two verdicts are asserted, and the shape says which:
 *   plain `it`  — the guard reads this form, so the dump is reported. It is the evidence the guard is not vacuous.
 *   `it.fails`  — the guard does NOT read this form. It is a pin of a MISS: the day someone closes it, this case turns
 *                 red and demands the same promotion W239 applied to the eight W41 pins.
 *
 * OWNERSHIP (w281, 24 Oct 2026; the tracker was read only). The three `it.fails` below are the three W256 added after
 * W247's census, and like W247's rows they have no owning ticket: each site says NO-TICKET and names the nearest ticket.
 * SHO-3032's Expected ("The guard flags the file, because it assembles" the process-image path) is the nearest and does
 * not match: these assemble a PROGRAM word, not that path, and 3032's precision fix is already in this tree and asserted
 * green at tests/no-proc-environ-2917.test.ts:381 while all three of these still miss. No assertion was changed and no
 * `it.fails` became an `it`.
 */
import { describe, expect, it } from "vitest";
import { wholeEnvReads } from "./base-url-no-environ-dump.test";

/** The forms the scanner reports for one snippet, exactly as `violations()` would. */
function forms(text: string): string[] {
  return wholeEnvReads([{ file: "zz-w256-attack.test.ts", text }]).map(({ form }) => form);
}

describe("W256: the spellings W239 did not test", () => {
  // ---- read, because the program position is judged on the text a literal really has -------------------------------
  it("a no-substitution template literal in the program position is read as its text", () => {
    // `ts.isStringLiteralLike` covers NoSubstitutionTemplateLiteral, so a backtick with no ${} is still a literal.
    expect(forms("execSync(`printenv`);")).toContain("environment printed by a child process");
  });

  it("a spawned shell running printenv out of its own argv is read", () => {
    // js: spawn("bash", ["-c", "printenv"]) — the dump is inside the child's argv, not on the parent's command line.
    // (The wrapper-inside-argv variant `spawn("sh", ["-c", "nohup printenv"])` is W239's own closure, asserted in that
    // guard's W239 block; it is deliberately NOT asserted here, because this file must be green on the pre-W239 line
    // too — it pins what is open, not what W239 already closed.)
    expect(forms(`spawn("bash", ["-c", "printenv"]);`)).toContain("environment printed by a child process");
  });

  // ---- MISS A: an assembly built from two bound literals ----------------------------------------------------------
  // NO-TICKET. Nearest is SHO-3032 (the guard missing a MID-WORD SPLIT of the process-image path), and it does not
  // match: this joins two bound names with +, that path never appears, and 3032's fix is already in this tree and green
  // at tests/no-proc-environ-2917.test.ts:381 while this still misses. SHO-3031 is the false positive on that path;
  // SHO-2917 AC3 is a read of it. Pin kept, assertion unchanged.
  it.fails("W256 MISS A: a command concatenated from two literal-bound names is not resolved", () => {
    // `literalText` resolves a name to a StringLiteralLike; a BinaryExpression is neither, so the command line is
    // "computed" and the call is skipped. Statically this IS resolvable in one expression, which is why it is a miss
    // of the same class W239 closed for a single bound literal (`const CMD = "printenv"; execSync(CMD)`).
    expect(forms(`const FIRST = "print";\nconst SECOND = "env";\nexecSync(FIRST + SECOND);`)).toContain(
      "environment printed by a child process",
    );
  });

  // ---- MISS B: a template literal with a span ----------------------------------------------------------------
  // NO-TICKET. This is the closest of the three in form to SHO-3032 -- one word split inside one expression -- but that
  // ticket's Expected is the guard flagging a file that assembles the process-image path, and its fix (in and green at
  // tests/no-proc-environ-2917.test.ts:381) leaves this miss in place, so it does not own it. Pin kept.
  it.fails("W256 MISS B: a template whose span is a literal is not resolved", () => {
    // `\`print${"env"}\`` is a TemplateExpression, so `literalText` returns null. The words are all in this file.
    expect(forms('execSync(`print${"env"}`);')).toContain("environment printed by a child process");
  });

  // ---- MISS C: a Buffer, a run-time value rather than text -----------------------------------------------------
  // NO-TICKET. SHO-3032's own Note -- "A source scan can't catch every obfuscation. A run-time `fs` spy in a Vitest
  // setup file would be the more robust follow-up" -- states this boundary but is not a decision to fix it, and no ticket
  // tracks the base64/char-code class (LIMIT 3). Pin kept, so the limit stays a measured boundary, not a claim.
  it.fails("W256 MISS C: a command decoded from a Buffer is not resolved", () => {
    // A value, not a form: this is LIMIT 3's class (base64/char-code assembly), and it is stated there rather than
    // hidden. Pinned so the limit is a measured boundary and not a claim.
    expect(forms(`execSync(Buffer.from("cHJpbnRlbnY=", "base64").toString());`)).toContain(
      "environment printed by a child process",
    );
  });
});
