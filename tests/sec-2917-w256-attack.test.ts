import { describe, expect, it } from "vitest";
import { wholeEnvReads } from "./base-url-no-environ-dump.test";

/** The forms the scanner reports for one snippet, exactly as `violations()` would. */
function forms(text: string): string[] {
  return wholeEnvReads([{ file: "zz-w256-attack.test.ts", text }]).map(({ form }) => form);
}

describe("W256: the spellings W239 did not test", () => {
  it("a no-substitution template literal in the program position is read as its text", () => {
    expect(forms("execSync(`printenv`);")).toContain("environment printed by a child process");
  });

  it("a spawned shell running printenv out of its own argv is read", () => {
    expect(forms(`spawn("bash", ["-c", "printenv"]);`)).toContain("environment printed by a child process");
  });

  it("W256 A: a command concatenated from two literal-bound names is resolved", () => {
    expect(forms(`const FIRST = "print";\nconst SECOND = "env";\nexecSync(FIRST + SECOND);`)).toContain(
      "environment printed by a child process",
    );
  });

  it("W256 B: a template whose span is a literal is resolved", () => {
    expect(forms('execSync(`print${"env"}`);')).toContain("environment printed by a child process");
  });

  it("W256 C: a command decoded from a Buffer is resolved", () => {
    expect(forms(`execSync(Buffer.from("cHJpbnRlbnY=", "base64").toString());`)).toContain(
      "environment printed by a child process",
    );
  });
});

describe("computed command controls", () => {
  it("does not flag a harmless statically assembled command", () => {
    expect(forms('const first = "ec"; execSync(first + "ho hello");')).toEqual([]);
  });
  it("does not execute unknown expressions while resolving a command", () => {
    expect(forms('execSync(`echo ${unknownCall()}`);')).toEqual([]);
  });
});
