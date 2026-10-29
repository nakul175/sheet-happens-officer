import { describe, expect, it } from "vitest";
import { compareSubmissionDeadlines, resolveSubmissionDeadline, submissionDeadlineLabel, submissionDeadlinePassed } from "@/lib/submission-deadline";
import { deadlineJSON, deadlinePatch } from "@/lib/submission-deadline-data";
const legacy = { submissionDeadline: new Date("2026-10-29T00:00:00Z"), submissionDeadlineAt: null, submissionDeadlineZone: null };
describe("SHO-3054 exact Bid deadline", () => {
  it("round-trips the explicit India cutoff without changing the calendar date", () => {
    const row = deadlinePatch({ submissionDeadline: "2026-10-29", submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata" }, undefined, true);
    expect(row.submissionDeadlineAt?.toISOString()).toBe("2026-10-29T12:00:00.000Z");
    const data = deadlineJSON(row as Parameters<typeof deadlineJSON>[0]);
    expect(data).toMatchObject({ submissionDeadline: "2026-10-29", submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata" });
    expect(submissionDeadlineLabel(data)).toContain("2026-10-29 17:30 Asia/Kolkata (GMT+5:30)");
  });
  it.each([["2026-02-30", "12:00", "UTC"], ["2026-10-29", "24:00", "UTC"], ["2026-10-29", "12:65", "UTC"], ["2026-10-29", "12:00", "No/SuchZone"]])("rejects invalid date/time/zone %s %s %s", (day, time, zone) => {
    expect(() => resolveSubmissionDeadline(day, time, zone)).toThrow();
  });
  it("refuses a DST gap instead of silently shifting the local cutoff", () => {
    expect(() => resolveSubmissionDeadline("2026-03-08", "02:30", "America/New_York")).toThrow(/does not exist/);
  });
  it("requires an explicit DST fold choice and preserves both exact occurrences", () => {
    expect(() => resolveSubmissionDeadline("2026-11-01", "01:30", "America/New_York")).toThrow(/occurs twice/);
    expect(resolveSubmissionDeadline("2026-11-01", "01:30", "America/New_York", "earlier").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(resolveSubmissionDeadline("2026-11-01", "01:30", "America/New_York", "later").toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
  it("preserves an unchanged date-only record, but requires time and zone for new/changed Bids", () => {
    expect(deadlinePatch({ submissionDeadline: "2026-10-29", submissionDeadlineTime: null, submissionDeadlineZone: null }, legacy, true)).toEqual({});
    expect(deadlinePatch({ }, legacy, true)).toEqual({});
    expect(() => deadlinePatch({ submissionDeadline: "2026-10-30" }, legacy, true)).toThrow(/date, time, and timezone/);
    expect(() => deadlinePatch({ submissionDeadline: "2026-10-29" }, undefined, true)).toThrow(/date, time, and timezone/);
    expect(deadlineJSON(legacy)).toMatchObject({ submissionDeadlineAt: null, submissionDeadlineZone: null, submissionDeadlineTime: null });
    expect(submissionDeadlineLabel(deadlineJSON(legacy))).toBe("2026-10-29 (date only)");
  });
  it("keeps the selected fold instant when unrelated edits resubmit identical local values", () => {
    const row = { ...legacy, submissionDeadline: new Date("2026-11-01T00:00:00Z"), submissionDeadlineAt: new Date("2026-11-01T06:30:00Z"), submissionDeadlineZone: "America/New_York" };
    expect(deadlinePatch({ submissionDeadline: "2026-11-01", submissionDeadlineTime: "01:30", submissionDeadlineZone: "America/New_York" }, row, true)).toEqual({});
    expect(() => deadlinePatch({ submissionDeadlineTime: null, submissionDeadlineZone: null }, row, true)).toThrow();
  });
  it("compares timed cutoffs by instant and date-only records by the existing India calendar", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(submissionDeadlinePassed({ submissionDeadline: "2026-10-29", submissionDeadlineAt: new Date(now - 1).toISOString() }, now)).toBe(true);
    expect(submissionDeadlinePassed({ submissionDeadline: "2026-10-29", submissionDeadlineAt: new Date(now + 1).toISOString() }, now)).toBe(false);
    expect(submissionDeadlinePassed({ submissionDeadline: "2026-10-29" }, Date.parse("2026-10-29T18:29:59Z"))).toBe(false);
    expect(submissionDeadlinePassed({ submissionDeadline: "2026-10-29" }, Date.parse("2026-10-29T18:30:00Z"))).toBe(true);
    expect(compareSubmissionDeadlines({ submissionDeadline: "2026-10-29", submissionDeadlineAt: "2026-10-29T13:00:00Z" }, { submissionDeadline: "2026-10-30", submissionDeadlineAt: "2026-10-29T12:00:00Z" })).toBeGreaterThan(0);
    // Timed and date-only groups stay distinct; date-only values are never converted to an instant for sorting.
    expect(compareSubmissionDeadlines({ submissionDeadline: "2026-11-01", submissionDeadlineAt: "2026-11-01T12:00:00Z" }, { submissionDeadline: "2026-10-01" })).toBeLessThan(0);
    expect(compareSubmissionDeadlines({ submissionDeadline: "2026-10-01" }, { submissionDeadline: "2026-10-02" })).toBeLessThan(0);
  });
});
