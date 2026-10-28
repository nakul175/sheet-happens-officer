import { describe, expect, it } from "vitest";
import { dateLabel, wordsToDate } from "../src/lib/datewords";

describe("SHO-3057 local date entry", () => {
  const now = new Date("2026-10-24T06:00:00Z");
  it("accepts Indian numeric and named-month dates alongside existing formats", () => {
    for (const input of ["25/10/2026", "25 Oct", "25 October", "25 oct 2026", "2026-10-25", "tomorrow"]) {
      expect(wordsToDate(input, now), input).toBe("2026-10-25");
    }
    expect(wordsToDate("1/2/2026", now)).toBe("2026-02-01");
    expect(wordsToDate("fri", now)).toBe("2026-10-30");
    expect(wordsToDate("in 3 days", now)).toBe("2026-10-27");
  });
  it("rejects impossible days rather than letting Date roll into another month", () => {
    for (const input of ["31/02/2026", "29/02/2026", "31 Apr", "32 Oct", "25 Foo", "10/25/2026", "25/10/26", "31 April 2026"]) {
      expect(wordsToDate(input, now), input).toBeNull();
    }
    expect(wordsToDate("29/02/2028", now)).toBe("2028-02-29");
    expect(wordsToDate("29 February 2028", now)).toBe("2028-02-29");
  });
  it("uses the current India-calendar year explicitly for an omitted year", () => {
    const indiaNewYear = new Date("2026-12-31T18:45:00Z");
    expect(wordsToDate("1 Jan", indiaNewYear)).toBe("2027-01-01");
    expect(wordsToDate("1 Jan", now)).toBe("2026-01-01");
    expect(dateLabel("2026-10-25", true)).toBe("Sun 25 Oct 2026");
    expect(dateLabel("2026-10-25")).toBe("Sun 25 Oct");
  });
});
