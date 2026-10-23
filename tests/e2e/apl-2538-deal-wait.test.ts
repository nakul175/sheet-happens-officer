// APL-2538 AC3 (SHO-2920): "Not listed? New organisation" converts a task opened at /projects/<source>?task=<task>, and
// the dialog pushes /projects/<deal>. The wait must name the deal it moved to. These tests hold the predicate the AC3
// story uses to that: it may resolve on that deal's own page and on nothing else. No browser, no server, no data.
import { describe, expect, it } from "vitest";
import { atDeal } from "./helpers/deal-wait";

const url = (path: string) => new URL(`http://127.0.0.1:3122${path}`);
const DEAL = "deal_project";
/** The wait the AC3 story carries, for the deal the dialog created. */
const wait = atDeal(DEAL);

describe("APL-2538 AC3: the wait resolves on the deal the task moved to, and only there", () => {
  it("does not resolve before the move, at /projects/<source>?task=<task>", () => {
    expect(wait(url("/projects/src_project?task=t1"))).toBe(false);
  });

  it("does not resolve on a project that is not this task's deal", () => {
    // The convert dialog creates exactly one deal and pushes it. Landing anywhere else must keep the wait waiting.
    expect(wait(url("/projects/some_other_deal"))).toBe(false);
  });

  it("resolves on the deal's own page", () => {
    expect(wait(url(`/projects/${DEAL}`))).toBe(true);
  });

  it("is stricter than the loose forms the spec used to carry", () => {
    // Why /projects/ was not proof: it matched the pre-move URL itself.
    expect(/\/projects\//.test(String(url("/projects/src_project?task=t1")))).toBe(true);
    // And why "not the source" is not proof either: it matched a sibling record.
    const otherThanSource = (u: URL) => {
      const m = /^\/projects\/([^/]+)$/.exec(u.pathname);
      return !!m && m[1] !== "src_project";
    };
    expect(otherThanSource(url("/projects/some_other_deal"))).toBe(true);
    expect(wait(url("/projects/some_other_deal"))).toBe(false);
  });
});
