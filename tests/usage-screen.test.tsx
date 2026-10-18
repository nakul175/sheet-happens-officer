// SHO-US-9.2 AC6: the Usage screen shows spend to date against the monthly ceiling
// from the figures /api/usage already returns. Any other role is refused, and no chat text is shown.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageContents, usagePath, usageTitle, type UsagePayload, type UsageRole } from "@/app/(app)/usage/screen";

const CHAT = "PRIVATE-CHAT-TEXT";

function payload(): UsagePayload & { chatText: string } {
  return {
    monthStart: "2026-09-30T18:30:00.000Z",
    weekStart: "2026-10-11T18:30:00.000Z",
    // 10 / 80 would be 12.5. The screen must show the API's 15, not a figure it worked out itself.
    ceiling: { usd: 80, spendUsd: 10, percent: 15 },
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
    expect(html).toContain("15%");
    expect(html).not.toContain("12.5%");
    expect(html).toContain('aria-valuetext="$10.00 of $80.00, 15% used"');
    expect(html).toContain('style="width:15%"');
    expect(html).not.toContain(CHAT);
    expect(html).not.toContain("Overdue tasks");
    expect(html).not.toContain("Messages this month");

    const over = payload();
    over.ceiling = { usd: 100, spendUsd: 112.4, percent: 112.4 };
    const full = htmlFor("SUPER_ADMIN", over);
    expect(full).toContain("$112.40");
    expect(full).toContain("$100.00");
    expect(full).toContain("112.4%");
    expect(full).toContain('style="width:100%"');
    expect(full).not.toContain(CHAT);
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
