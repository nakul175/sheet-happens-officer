// SHO-US-9.2 AC6: the Usage screen shows spend to date against the monthly ceiling
// from the figures /api/usage already returns. Any other role is refused, and no chat text is shown.
// ceiling.percent is the display string (the % sign is already in it). The screen does not work it out again.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageContents, meterWidth, usagePath, usageTitle, type UsagePayload, type UsageRole } from "@/app/(app)/usage/screen";
import { percentUsedLabel } from "@/lib/usage-percent";

const CHAT = "PRIVATE-CHAT-TEXT";

function payload(ceiling?: Partial<UsagePayload["ceiling"]>): UsagePayload & { chatText: string } {
  return {
    monthStart: "2026-09-30T18:30:00.000Z",
    weekStart: "2026-10-11T18:30:00.000Z",
    // 10 of 80 is 13%. A different string here proves the screen prints the API figure.
    ceiling: { usd: 80, spendUsd: 10, percent: "15%", ...ceiling },
    month: { calls: 3, inputTokens: 1200, outputTokens: 340, costUsd: 10, messages: 17 },
    quickActions: [{ id: "overdue", label: "Overdue tasks", count: 4 }],
    people: [{ id: "p1", name: "Asha", monthCalls: 3, weekCalls: 1, monthCostUsd: 10 }],
    chatText: CHAT,
  };
}

function htmlFor(role: UsageRole, data: UsagePayload | null = payload()) {
  return renderToStaticMarkup(<UsageContents role={role} loading={false} error={null} data={data} />);
}

describe("Usage screen (SHO-US-9.2 AC6)", () => {
  it("shows the Super Admin spend to date, the monthly ceiling and the percentage used", () => {
    const html = htmlFor("SUPER_ADMIN");
    expect(usageTitle("SUPER_ADMIN")).toBe("Usage");
    expect(usagePath("SUPER_ADMIN")).toBe("/api/usage");
    expect(html).toContain("Spend to date");
    expect(html).toContain("$10.00");
    expect(html).toContain("Monthly ceiling");
    expect(html).toContain("$80.00");
    expect(html).toContain("Percentage used");
    // The API said 15%. 10 of 80 is 13%, and the old one-decimal formula was 12.5. The screen prints the API string.
    expect(html).toContain("15%");
    expect(html).not.toContain("13%");
    expect(html).not.toContain("12.5%");
    expect(html).not.toContain("15%%");
    expect(html).toContain('aria-valuetext="$10.00 of $80.00, 15% used"');
    expect(html).toContain('style="width:15%"');
    expect(html).not.toContain(CHAT);
    expect(html).not.toContain("Overdue tasks");
    expect(html).not.toContain("Messages this month");
  });

  it("prints the display string for 0, under 1%, the 12.5 half-up case, 100% and over 100%", () => {
    const cases = [
      { spendUsd: 0, usd: 80, percent: percentUsedLabel(0, 80), width: "0%" },
      { spendUsd: 0.01, usd: 80, percent: percentUsedLabel(0.01, 80), width: null },
      { spendUsd: 10, usd: 80, percent: percentUsedLabel(10, 80), width: "13%" },
      { spendUsd: 100, usd: 100, percent: percentUsedLabel(100, 100), width: "100%" },
      { spendUsd: 120, usd: 100, percent: percentUsedLabel(120, 100), width: "100%" },
    ] as const;
    expect(cases.map((c) => c.percent)).toEqual(["0%", "<1%", "13%", "100%", "120%"]);

    for (const c of cases) {
      const html = htmlFor("SUPER_ADMIN", payload({ usd: c.usd, spendUsd: c.spendUsd, percent: c.percent }));
      const shown = c.percent === "<1%" ? "&lt;1%" : c.percent;
      expect(html).toContain(`<dt>Percentage used</dt><dd>${shown}</dd>`);
      expect(html).not.toContain(`${shown}%`);
      expect(html).toContain(`aria-valuetext="$${c.spendUsd.toFixed(2)} of $${c.usd.toFixed(2)}, ${shown} used"`);
      if (c.width) expect(html).toContain(`style="width:${c.width}"`);
      expect(html).not.toContain(CHAT);
    }

    const under = meterWidth("<1%", 0.01, 80);
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(1);
    expect(meterWidth("120%", 120, 100)).toBe(100);
    expect(meterWidth("0%", 0, 80)).toBe(0);
    expect(meterWidth("100%", 100, 100)).toBe(100);
  });

  it("refuses every role other than Super Admin and shows no figures and no chat text", () => {
    for (const role of ["MEMBER", "ADMIN"] as const) {
      const html = htmlFor(role);
      expect(usageTitle(role)).toBe("This page isn't available");
      expect(usagePath(role)).toBeNull();
      expect(html).toContain("Only the Super Admin can see usage.");
      expect(html).not.toContain("$10.00");
      expect(html).not.toContain("$80.00");
      expect(html).not.toContain("15%");
      expect(html).not.toContain("Asha");
      expect(html).not.toContain(CHAT);
      expect(html).not.toContain("Overdue tasks");
    }
  });
});
