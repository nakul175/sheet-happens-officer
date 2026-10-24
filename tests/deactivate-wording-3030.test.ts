// SHO-3030, follow-up to PR #156 (APL-2995). The deactivation dialog must say why a project's tasks went
// to its Leader: the named person is not a Leader or Editor there (SHO-US-2.4 AC2), which includes a member
// who is only a Viewer. "Not on the project" was the imprecise claim. Copy only; the reassignment behaviour
// (including hidden deal names in fellBack) is covered by tests/deactivate-fellback-2995.test.ts.
import { describe, expect, it } from "vitest";
import { FALLBACK_HINT, fellBackHint } from "../src/app/(app)/team/Team";

const ONE = "ZZ-TEST Plain project 3030";
const TWO = ["ZZ-TEST Alpha 3030", "ZZ-TEST Beta 3030"];

describe("qa:TC missing SHO-3030 deactivate dialog wording", () => {
  it("qa:TC missing D1: the summary names the role for one project", () => {
    expect(fellBackHint([ONE])).toBe(
      `The Leader took the tasks in ${ONE}, because the person you named is not a Leader or Editor on that project.`,
    );
  });

  it("qa:TC missing D1: the summary keeps that/those in step with the list", () => {
    expect(fellBackHint(TWO)).toBe(
      `The Leader took the tasks in ${TWO.join(", ")}, because the person you named is not a Leader or Editor on those projects.`,
    );
  });

  it("qa:TC missing D1: the Deactivate dialog hint names the role too", () => {
    expect(FALLBACK_HINT).toBe(
      "If the person you name is not a Leader or Editor on a project, that project's Leader takes those tasks.",
    );
  });

  it("qa:TC missing D1: no sentence claims the person is merely not on the project", () => {
    for (const text of [fellBackHint([ONE]), fellBackHint(TWO), FALLBACK_HINT]) {
      expect(text).toContain("Leader or Editor");
      expect(text).not.toMatch(/\bnot on (a|that|those) projects?\b/);
    }
  });
});
