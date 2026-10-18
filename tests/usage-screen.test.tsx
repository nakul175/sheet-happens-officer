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
    // 2 + 4 + 0 + 1 + 3 = 10. The message total must stay 17, not 27.
    quickActions: [
      { id: "due-week", label: "Due this week", count: 2 },
      { id: "overdue", label: "Overdue", count: 4 },
      { id: "waiting-on-me", label: "Waiting on me", count: 0 },
      { id: "blocked", label: "Blocked", count: 1 },
      { id: "recently-completed", label: "Recently completed", count: 3 },
    ],
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
      expect(html).not.toContain("Messages this month");
      expect(html).not.toContain("Quick actions this month");
      expect(html).not.toContain("Due this week");
      expect(html).not.toContain("Recently completed");
      expect(html).not.toContain(">17<");
    }
  });

  it("shows messages this month and each quick-action count, and keeps quick actions out of the message total (APL-2641 AC1, AC2)", () => {
    const html = htmlFor("SUPER_ADMIN");
    expect(html).toMatch(/Messages this month<\/h2>\s*<p class="usage-count">17<\/p>/);
    expect(html).toContain("Quick actions are not included.");
    expect(html).toContain("<dt>Due this week</dt><dd>2</dd>");
    expect(html).toContain("<dt>Overdue</dt><dd>4</dd>");
    expect(html).toContain("<dt>Waiting on me</dt><dd>0</dd>");
    expect(html).toContain("<dt>Blocked</dt><dd>1</dd>");
    expect(html).toContain("<dt>Recently completed</dt><dd>3</dd>");
    expect(html).not.toContain(">27<");
    expect(html).not.toContain(">21<");
    expect(html).not.toContain(CHAT);
  });

  it("shows zero messages and zero quick-action counts when the month figures are zero (APL-2641 AC3)", () => {
    const data = payload();
    data.month = { ...data.month, messages: 0 };
    data.quickActions = data.quickActions!.map((q) => ({ ...q, count: 0 }));
    const html = htmlFor("SUPER_ADMIN", data);
    expect(html).toMatch(/Messages this month<\/h2>\s*<p class="usage-count">0<\/p>/);
    expect(html).toContain("<dt>Due this week</dt><dd>0</dd>");
    expect(html).toContain("<dt>Overdue</dt><dd>0</dd>");
    expect(html).toContain("<dt>Waiting on me</dt><dd>0</dd>");
    expect(html).toContain("<dt>Blocked</dt><dd>0</dd>");
    expect(html).toContain("<dt>Recently completed</dt><dd>0</dd>");
    expect(html).not.toContain(">17<");
    expect(html).not.toContain(CHAT);
  });
});
