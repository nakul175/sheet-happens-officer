// APL-2733: a bad password lists PASSWORD_MESSAGE once per failure.
// The length checks and the letter-and-number check share that message, so a
// password that fails more than one of them used to put it in issues twice.
// signUpInput, resetInput and passwordChange all use passwordField, so the abort
// on the length checks covers sign-up, reset-password and change-password.
import { describe, expect, it } from "vitest";
import { passwordChange } from "@/lib/feed";
import { PASSWORD_MESSAGE, resetInput, signUpInput } from "@/lib/schemas";

const NAME = "ZZ-TEST Signup";
const EMAIL = "zz-test-signup@aplyd.com";
const RESET_TOKEN = "zz-test-reset-token-0123456789";
const CURRENT = "current-pass-1";

type Parsed = { success: true } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };

function listed(parsed: Parsed) {
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** The issues list the sign-up API returns for this password. */
function issues(password: string) {
  return listed(signUpInput.safeParse({ name: NAME, email: EMAIL, password }));
}

/** The issues list the reset-password API returns when confirm matches. */
function resetIssues(password: string) {
  return listed(resetInput.safeParse({ token: RESET_TOKEN, password, confirm: password }));
}

/** The issues list the change-password API returns when confirm matches. */
function changeIssues(password: string) {
  return listed(passwordChange.safeParse({ current: CURRENT, password, confirm: password }));
}

function expectNoDuplicates(list: { path: PropertyKey[]; message: string }[]) {
  const seen = list.map((issue) => JSON.stringify(issue));
  expect(seen).toEqual([...new Set(seen)]);
}

describe("sign-up password issues (APL-2733)", () => {
  it("reports a short password once qa:TC missing", () => {
    // "short1" is only too short. "abc" is too short and has no digit, which used to emit the message twice.
    for (const password of ["short1", "abc"]) {
      const list = issues(password);
      expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("reports a long password once qa:TC missing", () => {
    // 129 characters with a letter and a number fails only the max rule.
    // 129 letters fail max and the letter-and-number rule, which used to emit the message twice.
    for (const password of ["a".repeat(128) + "1", "a".repeat(129)]) {
      const list = issues(password);
      expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("reports a password with no digit once qa:TC missing", () => {
    const list = issues("abcdefgh");
    expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
    expectNoDuplicates(list);
  });

  it("reports a password with no letter once qa:TC missing", () => {
    const list = issues("12345678");
    expect(list).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
    expectNoDuplicates(list);
  });

  it("accepts a valid password qa:TC missing", () => {
    const parsed = signUpInput.safeParse({ name: NAME, email: EMAIL, password: "goodpass7" });
    expect(parsed.success).toBe(true);
    const list = issues("goodpass7");
    expect(list).toEqual([]);
    expectNoDuplicates(list);
  });
});

const BAD = ["short1", "abc", "a".repeat(128) + "1", "a".repeat(129), "abcdefgh", "12345678"] as const;

describe("reset-password issues (APL-2733)", () => {
  it("reports each bad password once qa:TC missing", () => {
    for (const password of BAD) {
      const list = resetIssues(password);
      expect(list, password).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("accepts a valid password qa:TC missing", () => {
    const parsed = resetInput.safeParse({ token: RESET_TOKEN, password: "goodpass7", confirm: "goodpass7" });
    expect(parsed.success).toBe(true);
    const list = resetIssues("goodpass7");
    expect(list).toEqual([]);
    expectNoDuplicates(list);
  });
});

describe("change-password issues (APL-2733)", () => {
  it("reports each bad password once qa:TC missing", () => {
    for (const password of BAD) {
      const list = changeIssues(password);
      expect(list, password).toEqual([{ path: ["password"], message: PASSWORD_MESSAGE }]);
      expectNoDuplicates(list);
    }
  });

  it("accepts a valid password qa:TC missing", () => {
    const parsed = passwordChange.safeParse({ current: CURRENT, password: "goodpass7", confirm: "goodpass7" });
    expect(parsed.success).toBe(true);
    const list = changeIssues("goodpass7");
    expect(list).toEqual([]);
    expectNoDuplicates(list);
  });
});
