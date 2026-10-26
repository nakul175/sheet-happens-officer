import { describe, expect, it } from "vitest";
import { dealCalendarDate, matchesDealDate, type DealDateFilter } from "../src/lib/deal-date-filter";
const base: DealDateFilter = { field: "submissionDeadline", start: "", end: "", undated: "include" };
describe("SHO-3043 timeline", () => {
  it("uses IST across UTC midnight and preserves date-only values", () => {
    expect(dealCalendarDate("2026-10-25T18:30:00Z")).toBe("2026-10-26");
    expect(dealCalendarDate("2026-10-25T18:29:59Z")).toBe("2026-10-25");
    expect(dealCalendarDate("2026-10-25")).toBe("2026-10-25");
  });
  it.each([
    ["2026-10-25", true], ["2026-10-26", true], ["2026-10-24", false], ["2026-10-27", false],
  ])("bounded range includes calendar boundaries %s", (date, expected) => {
    expect(matchesDealDate({ submissionDeadline: date }, { ...base, start: "2026-10-25", end: "2026-10-26" })).toBe(expected);
  });
  it("supports either bound and refuses reversed ranges", () => {
    expect(matchesDealDate({ submissionDeadline: "2026-10-26" }, { ...base, start: "2026-10-25" })).toBe(true);
    expect(matchesDealDate({ submissionDeadline: "2026-10-24" }, { ...base, end: "2026-10-25" })).toBe(true);
    expect(matchesDealDate({}, { ...base, start: "2026-10-26", end: "2026-10-25" })).toBe(false);
  });
  it("makes missing dates explicit and selectable", () => {
    expect(matchesDealDate({}, base)).toBe(true);
    expect(matchesDealDate({}, { ...base, undated: "exclude" })).toBe(false);
    expect(matchesDealDate({}, { ...base, undated: "only" })).toBe(true);
    expect(matchesDealDate({ submissionDeadline: "2026-10-25" }, { ...base, undated: "only" })).toBe(false);
  });
  it("uses only the selected date basis", () => {
    expect(matchesDealDate({ expectedClose: "2026-10-25", submissionDeadline: "2026-11-01" }, { ...base, field: "expectedClose", end: "2026-10-25" })).toBe(true);
  });
});
