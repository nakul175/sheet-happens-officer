// APL-2519 AC6: the percentage used is one display string, rounded half up.
// The cases are the ones tests/e2e/stories/APL-2519.spec.ts expects on the screen.
import { describe, expect, it } from "vitest";
import { hasCeiling, overCeiling, percentUsedLabel, percentUsedNumber } from "@/lib/usage-percent";

/** The one-decimal figure /api/usage used to store. The screen must not print this. */
const oldDecimal = (spend: number, ceiling: number) => (ceiling > 0 ? Math.round((spend / ceiling) * 1000) / 10 : 0);

describe("percentUsedLabel (APL-2519 AC6)", () => {
  it("shows 0% for no spend", () => {
    expect(percentUsedLabel(0, 80)).toBe("0%");
    expect(percentUsedLabel(-1, 80)).toBe("0%");
  });

  it("shows <1% for any nonzero spend under 1%, including a half that would otherwise become 1%", () => {
    expect(percentUsedLabel(0.01, 80)).toBe("<1%"); // 0.0125%
    expect(percentUsedLabel(1e-7, 1)).toBe("<1%");
    expect(percentUsedLabel(0.4, 80)).toBe("<1%"); // 0.5%, not "1%"
    expect(percentUsedLabel(0.79, 80)).toBe("<1%"); // 0.9875%; Math.round would say 1
    expect(percentUsedLabel(0.8, 80)).toBe("1%"); // exactly 1%
  });

  it("rounds 10 of 80 (12.5) half up to 13%", () => {
    expect(percentUsedLabel(10, 80)).toBe("13%");
    expect(Math.round((10 / 80) * 1000) / 10).toBe(12.5);
  });

  it("shows 100% at the ceiling and the real rounded figure past it", () => {
    expect(percentUsedLabel(80, 80)).toBe("100%");
    expect(percentUsedLabel(100, 100)).toBe("100%");
    expect(percentUsedLabel(120, 100)).toBe("120%");
    expect(percentUsedLabel(112.5, 100)).toBe("113%");
  });

  it("matches the APL-2519 e2e rows, including where the old one-decimal figure differs", () => {
    const rows: [number, number, string][] = [
      [0, 80, "0%"],
      [1, 200, "<1%"],
      [1, 1000, "<1%"],
      [1, 101, "<1%"],
      [1, 100, "1%"],
      [10, 80, "13%"],
      [124, 1000, "12%"],
      [120, 100, "120%"],
      [112.4, 100, "112%"],
      [239, 200, "120%"],
    ];
    for (const [spend, cap, label] of rows) {
      expect(percentUsedLabel(spend, cap), `${spend} of ${cap}`).toBe(label);
      const stored = label === "0%" || label === "<1%" ? 0 : Number(label.slice(0, -1));
      expect(percentUsedNumber(spend, cap), `${spend} of ${cap}`).toBe(stored);
    }
    expect(oldDecimal(10, 80)).toBe(12.5);
    expect(oldDecimal(1, 101)).toBe(1);
    expect(percentUsedLabel(10, 80)).toBe("13%");
    expect(percentUsedLabel(1, 101)).toBe("<1%");
  });

  it("rounds a floating-point half up, where Math.round on the IEEE quotient goes down", () => {
    // 0.09 / 0.4 * 100 is 22.5 in decimal, but the IEEE quotient is 22.499999999999996.
    expect((0.09 / 0.4) * 100).toBeLessThan(22.5);
    expect(Math.round((0.09 / 0.4) * 100)).toBe(22);
    expect(percentUsedLabel(0.09, 0.4)).toBe("23%");
  });

  it('qa:TC-US92-30f41089@v1 AC6 v1.2: if the ceiling is 0 or unset, there is no percentage', () => {
    for (const cap of [0, -5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasCeiling(cap), String(cap)).toBe(false);
      for (const spend of [0, 10]) {
        expect(percentUsedLabel(spend, cap), `${spend} of ${cap}`).toBeNull();
        expect(percentUsedNumber(spend, cap), `${spend} of ${cap}`).toBe(0);
        expect(overCeiling(spend, cap), `${spend} of ${cap}`).toBe(false);
      }
    }
    expect(hasCeiling(80)).toBe(true);
  });

  it('qa:TC-US92-5acadabc@v1 qa:TC-US92-cd463d7f@v2 AC6 v1.2: over the ceiling is spend above it, and the percentage stays rounded', () => {
    const rows: [number, number, string, boolean][] = [
      [100.4, 100, "100%", true],
      [100.01, 100, "100%", true],
      [100.5, 100, "101%", true],
      [113, 100, "113%", true],
      [250, 100, "250%", true],
      [100, 100, "100%", false],
      [99.5, 100, "100%", false],
      [99.49, 100, "99%", false],
    ];
    for (const [spend, cap, label, over] of rows) {
      expect(percentUsedLabel(spend, cap), `${spend} of ${cap}`).toBe(label);
      expect(overCeiling(spend, cap), `${spend} of ${cap}`).toBe(over);
    }
  });
});
