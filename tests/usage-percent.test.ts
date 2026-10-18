// APL-2519 AC6: the percentage used is one display string, rounded half up.
import { describe, expect, it } from "vitest";
import { percentUsedLabel } from "@/lib/usage-percent";

describe("percentUsedLabel (APL-2519 AC6)", () => {
  it("shows 0% for no spend", () => {
    expect(percentUsedLabel(0, 80)).toBe("0%");
    expect(percentUsedLabel(0, 0)).toBe("0%");
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

  it("rounds a floating-point half up, where Math.round on the IEEE quotient goes down", () => {
    // 0.09 / 0.4 * 100 is 22.5 in decimal, but the IEEE quotient is 22.499999999999996.
    expect((0.09 / 0.4) * 100).toBeLessThan(22.5);
    expect(Math.round((0.09 / 0.4) * 100)).toBe(22);
    expect(percentUsedLabel(0.09, 0.4)).toBe("23%");
  });
});
