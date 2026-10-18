// APL-2733: sign-up must list the password message once per failure.
// The length checks and the letter-and-number check share PASSWORD_MESSAGE, so a
// password that fails more than one of them used to put that message in issues twice.
import { describe, expect, it } from "vitest";
import { PASSWORD_MESSAGE, signUpInput } from "@/lib/schemas";

const NAME = "ZZ-TEST Signup";
const EMAIL = "zz-test-signup@aplyd.com";

/** The issues list the sign-up API returns for this password. */
function issues(password: string) {
  const parsed = signUpInput.safeParse({ name: NAME, email: EMAIL, password });
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function expectNoDuplicates(list: { path: PropertyKey[]; message: string }[]) {
  const seen = list.map((issue) => JSON.stringify(issue));
  expect(seen).toEqual([...new Set(seen)]);
}

describe("sign-up password issues (APL-2733)", () => {
  it("reports a short password once", () => {
    // "short1" is only too short. "abc" is too short and has no digit, which used to emit the message twice.
    for (const password of ["short1", "abc"]) {
      const list = issues(password);
      expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("reports a long password once", () => {
    // 129 characters with a letter and a number fails only the max rule.
    // 129 letters fail max and the letter-and-number rule, which used to emit the message twice.
    for (const password of ["a".repeat(128) + "1", "a".repeat(129)]) {
      const list = issues(password);
      expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("reports a password with no digit once", () => {
    const list = issues("abcdefgh");
    expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
    expectNoDuplicates(list);
  });

  it("reports a password with no letter once", () => {
    const list = issues("12345678");
    expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
    expectNoDuplicates(list);
  });

  it("accepts a valid password", () => {
    const parsed = signUpInput.safeParse({ name: NAME, email: EMAIL, password: "goodpass7" });
    expect(parsed.success).toBe(true);
    const list = issues("goodpass7");
    expect(list).toEqual([]);
    expectNoDuplicates(list);
  });
});
