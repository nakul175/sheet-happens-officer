// APL-2644: on a phone sheet the blocked-reason box grows to about five lines, then scrolls inside.
import { describe, expect, it } from "vitest";
import { BLOCKED_REASON_MAX_LINES, blockedReasonBox, type BlockedReasonMetrics } from "../src/components/blocked-reason";

// Phone sheet field (320–599 px): 16px type, line-height 1.4, 8px padding, 1px border.
const phone: Omit<BlockedReasonMetrics, "scrollHeight"> = {
  lineHeight: 22.4, paddingTop: 8, paddingBottom: 8, borderTop: 1, borderBottom: 1,
};
const fiveLineCap = Math.round(phone.lineHeight * BLOCKED_REASON_MAX_LINES + phone.paddingTop + phone.paddingBottom + phone.borderTop + phone.borderBottom);

describe("blocked reason box (APL-2644)", () => {
  it("AC1: a 300-character reason on a phone sheet grows to five lines, then scrolls, and stays readable", () => {
    const reason = "Waiting on the signed paperwork from the vendor before finance can review the invoice and release the next milestone payment for the rollout.".padEnd(300, " more detail").slice(0, 300);
    expect(reason).toHaveLength(300);
    // Measured on a 320 px sheet: that reason wraps to a scrollHeight of 240, past five lines.
    const box = blockedReasonBox({ ...phone, scrollHeight: 240 });
    expect(box.scrolls).toBe(true);
    expect(box.overflowY).toBe("auto");
    expect(box.height).toBe(fiveLineCap);
    expect(box.height).toBeLessThan(240);
    expect(box.overflowWrap).toBe("anywhere");
  });

  it("AC2: a one-line reason is one line tall with no scrollbar", () => {
    // One line reports scrollHeight of line + padding (38) and no border. The line box itself is 22.4px.
    const box = blockedReasonBox({ ...phone, scrollHeight: 38 });
    expect(box.scrolls).toBe(false);
    expect(box.overflowY).toBe("hidden");
    expect(box.height).toBe(Math.ceil(Math.max(38, phone.lineHeight + phone.paddingTop + phone.paddingBottom) + phone.borderTop + phone.borderBottom));
    expect(box.height).toBeLessThan(phone.lineHeight * 2);
  });

  it("AC3: at the five-line maximum, scrolling stays inside so Close and the footer stay put", () => {
    const atFive = blockedReasonBox({ ...phone, scrollHeight: phone.lineHeight * 5 + phone.paddingTop + phone.paddingBottom });
    const pastFive = blockedReasonBox({ ...phone, scrollHeight: 400 });
    expect(atFive.height).toBe(fiveLineCap);
    expect(pastFive.height).toBe(atFive.height);
    expect(pastFive.overflowY).toBe("auto");
    // contain keeps the scroll inside the box, so the sheet, Close, and the page behind do not move.
    expect(pastFive.overscrollBehavior).toBe("contain");
  });
});
