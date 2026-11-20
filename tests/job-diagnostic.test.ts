import { expect, it } from "vitest";
import { displayedJobFailure, jobFailureCategory } from "@/lib/job-diagnostic";

it("retains only allowlisted failure codes, never exception text", () => {
  expect(jobFailureCategory(new Error("private connection string"))).toBe("UNKNOWN");
  expect(jobFailureCategory(Object.assign(new Error("private query"), { code: "P2010", meta: { code: "55P03" } }))).toBe("P2010/55P03");
  expect(jobFailureCategory({ code: "private-code://credential" })).toBe("UNKNOWN");
});

it("masks legacy stored messages before status or bell rendering", () => {
  const safe = "P2010/55P03 (e81b4ba1-11d6-48b3-a120-13c601d622b6)";
  expect(displayedJobFailure(safe)).toBe(safe);
  expect(displayedJobFailure("password=private connection string")).toBe("Earlier failure; details withheld");
  expect(displayedJobFailure("P2010/55P03 (bad-id) password=private")).toBe("Earlier failure; details withheld");
  expect(displayedJobFailure(null)).toBeNull();
});
