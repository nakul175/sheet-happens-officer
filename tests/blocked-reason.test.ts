// APL-2644: on a phone sheet the blocked-reason box grows with the reason.
// APL-2737 (APL-2555 AC2): it grows to show the whole reason, with no five-line cap and no scrolling inside.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCKED_REASON_MAX_LENGTH, blockedReasonBox, watchBlockedReason, type BlockedReasonMetrics } from "../src/components/blocked-reason";
import { taskUpdate } from "../src/lib/schemas";

// Phone sheet field (320–599 px): 16px type, line-height 1.4, 8px padding, 1px border.
const phone: Omit<BlockedReasonMetrics, "scrollHeight"> = {
  lineHeight: 22.4, paddingTop: 8, paddingBottom: 8, borderTop: 1, borderBottom: 1,
};
const border = phone.borderTop + phone.borderBottom;
const fiveLines = phone.lineHeight * 5 + phone.paddingTop + phone.paddingBottom + border;

describe("qa:TC missing blocked reason box (APL-2737)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("qa:TC missing AC1: a 300-character reason on a 320 px sheet grows past five lines to show all of it, with no inner scrollbar", () => {
    // Measured on a 320 px sheet: a 300-character reason wraps to a scrollHeight of 240, past five lines.
    const box = blockedReasonBox({ ...phone, scrollHeight: 240 });
    expect(box.height).toBe(240 + border);
    expect(box.height).toBeGreaterThan(fiveLines);
    expect(box.overflowY).toBe("auto");
    expect(box.overflowWrap).toBe("anywhere");
  });

  it("qa:TC missing AC1: the box is never shorter than its content, so nothing is clipped vertically", () => {
    for (const scrollHeight of [38, 60.5, 128, 240, 241.3, 400]) {
      const box = blockedReasonBox({ ...phone, scrollHeight });
      expect(box.height - border, `scrollHeight ${scrollHeight}`).toBeGreaterThanOrEqual(scrollHeight);
      expect(box.height - border - scrollHeight, `scrollHeight ${scrollHeight}`).toBeLessThanOrEqual(1);
    }
  });

  it("qa:TC missing AC1: a one-line reason stays one line tall", () => {
    // One line reports scrollHeight of line + padding (38) and no border. The line box itself is 22.4px.
    const box = blockedReasonBox({ ...phone, scrollHeight: 38 });
    expect(box.overflowY).toBe("auto");
    expect(box.height).toBe(Math.ceil(Math.max(38, phone.lineHeight + phone.paddingTop + phone.paddingBottom) + border));
    expect(box.height).toBeLessThan(phone.lineHeight * 2);
  });

  it("qa:TC missing AC1: the reason the box must show in full is capped at 300 characters by the task schema", () => {
    expect(taskUpdate.safeParse({ blockedReason: "x".repeat(300), expectedUpdatedAt: "v" }).success).toBe(true);
    expect(taskUpdate.safeParse({ blockedReason: "x".repeat(301), expectedUpdatedAt: "v" }).success).toBe(false);
    // The field's maxLength is the same limit, so a person cannot type past what the server accepts.
    expect(BLOCKED_REASON_MAX_LENGTH).toBe(300);
  });

  it("qa:TC missing AC1: the box is fitted again when its width changes (rotation or resize), and not on its own height change", () => {
    // A fake field: content height depends on width, as wrapping does in a browser.
    let width = 600;
    const style: Record<string, string> = {};
    const el = {
      style,
      get clientWidth() { return width; },
      get scrollHeight() { return width < 400 ? 240 : 128; },
    } as unknown as HTMLTextAreaElement;
    vi.stubGlobal("getComputedStyle", () => ({
      lineHeight: "22.4px", fontSize: "16px", paddingTop: "8px", paddingBottom: "8px", borderTopWidth: "1px", borderBottomWidth: "1px",
    }));
    let notify = () => {};
    let disconnected = false;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { notify = cb; }
      observe() {}
      disconnect() { disconnected = true; }
    });

    const stop = watchBlockedReason(el);
    expect(style.height).toBe("130px"); // landscape: 128 + border
    notify(); // the fit's own height change: same width, no refit
    expect(style.height).toBe("130px");
    width = 320; // rotate to portrait
    notify();
    expect(style.height).toBe(`${240 + border}px`);
    expect(style.overflowY).toBe("auto");
    stop();
    expect(disconnected).toBe(true);
  });
});
