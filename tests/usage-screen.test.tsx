// SHO-US-9.2 AC6: the Usage screen shows spend to date against the monthly ceiling.
// The percentage is percentUsedLabel(spend, ceiling). It is not ceiling.percent, so the old
// one-decimal figure (12.5 for 10 of 80, 1 for 1 of 101) does not appear on the screen.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageContents, meterWidth, usagePath, usageTitle, type UsagePayload, type UsageRole } from "@/app/(app)/usage/screen";
import { overCeiling, percentUsedLabel } from "@/lib/usage-percent";

const CHAT = "PRIVATE-CHAT-TEXT";

/** The one-decimal figure a stub of the old /api/usage still sends. */
const oldDecimal = (spend: number, ceiling: number) => (ceiling > 0 ? Math.round((spend / ceiling) * 1000) / 10 : 0);

function payload(ceiling?: Partial<UsagePayload["ceiling"]>): UsagePayload & { chatText: string } {
  return {
    monthStart: "2026-09-30T18:30:00.000Z",
    weekStart: "2026-10-11T18:30:00.000Z",
    // 10 of 80. The stored percent is the old 12.5. The screen shows 13%.
    ceiling: { usd: 80, spendUsd: 10, percent: oldDecimal(10, 80), ...ceiling },
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
    expect(oldDecimal(10, 80)).toBe(12.5);
    expect(html).toContain("<dt>Percentage used</dt><dd>13%</dd>");
    expect(html).not.toContain("12.5%");
    expect(html).toContain('aria-valuetext="$10.00 of $80.00, 13% used"');
    expect(html).toContain('style="width:13%"');
    expect(html).not.toContain(CHAT);

    // A stale percent of 15 does not override 10 of 80.
    const stale = htmlFor("SUPER_ADMIN", payload({ percent: 15 }));
    expect(stale).toContain("<dt>Percentage used</dt><dd>13%</dd>");
    expect(stale).not.toContain("15%");
  });

  it("prints 0%, <1%, 13%, 12%, 112% and 120% even when percent is the old one-decimal figure", () => {
    const rows: { spend: number; cap: number; label: string; width: string | null }[] = [
      { spend: 0, cap: 80, label: "0%", width: "0%" },
      { spend: 1, cap: 200, label: "<1%", width: null },
      { spend: 1, cap: 1000, label: "<1%", width: null },
      { spend: 1, cap: 101, label: "<1%", width: null },
      { spend: 1, cap: 100, label: "1%", width: "1%" },
      { spend: 10, cap: 80, label: "13%", width: "13%" },
      { spend: 124, cap: 1000, label: "12%", width: "12%" },
      { spend: 120, cap: 100, label: "120%", width: "100%" },
      { spend: 112.4, cap: 100, label: "112%", width: "100%" },
      { spend: 239, cap: 200, label: "120%", width: "100%" },
    ];
    for (const row of rows) {
      expect(percentUsedLabel(row.spend, row.cap), `${row.spend} of ${row.cap}`).toBe(row.label);
      const html = htmlFor("SUPER_ADMIN", payload({
        usd: row.cap,
        spendUsd: row.spend,
        percent: oldDecimal(row.spend, row.cap),
      }));
      const shown = row.label === "<1%" ? "&lt;1%" : row.label;
      // AC6 v1.1: 120%, 112% and 239 of 200 are over the ceiling, so the flag follows the percentage.
      const over = overCeiling(row.spend, row.cap);
      const flag = over ? ' <span class="usage-over">Over ceiling</span>' : "";
      expect(html, `${row.spend} of ${row.cap}`).toContain(`<dt>Percentage used</dt><dd>${shown}${flag}</dd>`);
      expect(html).not.toContain(`${shown}%`);
      expect(html).toContain(`aria-valuetext="$${row.spend.toFixed(2)} of $${row.cap.toFixed(2)}, ${shown} used${over ? ", over ceiling" : ""}"`);
      if (row.width) expect(html).toContain(`style="width:${row.width}"`);
      if (row.label === "<1%") expect(html).not.toContain(">1%<");
      expect(html).not.toContain(CHAT);
    }
    // 1 of 101 is 0.99%. The old one-decimal figure rounds that to 1, and the screen still says <1%.
    expect(oldDecimal(1, 101)).toBe(1);
    const under = meterWidth("<1%", 1, 101);
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(1);
  });

  it("refuses every role other than Super Admin and shows no figures and no chat text", () => {
    for (const role of ["MEMBER", "ADMIN"] as const) {
      const html = htmlFor(role);
      expect(usageTitle(role)).toBe("This page isn't available");
      expect(usagePath(role)).toBeNull();
      expect(html).toContain("Only the Super Admin can see usage.");
      expect(html).not.toContain("$10.00");
      expect(html).not.toContain("$80.00");
      expect(html).not.toContain("13%");
      expect(html).not.toContain("Asha");
      expect(html).not.toContain(CHAT);
      expect(html).not.toContain("Messages this month");
      expect(html).not.toContain("Quick actions this month");
      expect(html).not.toContain("Due this week");
      expect(html).not.toContain("Recently completed");
      expect(html).not.toContain(">17<");
    }
  });

  it("qa:TC missing shows messages this month and each quick-action count, and keeps quick actions out of the message total (APL-2641 AC1, AC2)", () => {
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

  it("qa:TC missing shows zero messages and zero quick-action counts when the month figures are zero (APL-2641 AC3)", () => {
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

  // AC6 v1.1 (Dwight, 19 Oct 01:24 IST). Render data only, named ZZ-TEST; nothing is written anywhere.
  const zz = (ceiling: Partial<UsagePayload["ceiling"]>): UsagePayload => ({
    ...payload(ceiling),
    people: [{ id: "zz-1", name: "ZZ-TEST usage person", monthCalls: 1, weekCalls: 1, monthCostUsd: ceiling.spendUsd ?? 0 }],
  });

  it('qa:TC-US92-30f41089@v1 AC6 v1.2: if the ceiling is 0 or unset, the screen shows "No ceiling set" and no percentage', () => {
    const cases: { label: string; ceiling: Partial<UsagePayload["ceiling"]> }[] = [
      { label: "$10 of $0", ceiling: { usd: 0, spendUsd: 10, percent: 0 } },
      { label: "$0 of $0", ceiling: { usd: 0, spendUsd: 0, percent: 0 } },
      { label: "$10, ceiling null", ceiling: { usd: null, spendUsd: 10, percent: 0 } },
      { label: "$10, ceiling missing", ceiling: { usd: undefined, spendUsd: 10, percent: 0 } },
    ];
    for (const c of cases) {
      const html = htmlFor("SUPER_ADMIN", zz(c.ceiling));
      expect(html, c.label).toContain("<dt>Monthly ceiling</dt><dd>No ceiling set</dd>");
      expect(html, c.label).toContain(`<dt>Spend to date</dt><dd>$${(c.ceiling.spendUsd ?? 0).toFixed(2)}</dd>`);
      expect(html, c.label).not.toContain("Percentage used");
      expect(html, c.label).not.toContain("%<");
      expect(html, c.label).not.toContain("% used");
      expect(html, c.label).not.toContain('role="meter"');
      expect(html, c.label).not.toContain("Over ceiling");
      expect(html, c.label).not.toMatch(/NaN|Infinity/);
      expect(html, c.label).not.toContain(CHAT);
    }
  });

  it('qa:TC-US92-5acadabc@v1 qa:TC-US92-cd463d7f@v2 AC6 v1.2: if spend is over the ceiling, the screen shows the rounded percentage plus a visible "Over ceiling" flag', () => {
    const rows: { spend: number; cap: number; label: string; over: boolean }[] = [
      { spend: 100.4, cap: 100, label: "100%", over: true },
      { spend: 100.01, cap: 100, label: "100%", over: true },
      { spend: 100.5, cap: 100, label: "101%", over: true },
      { spend: 113, cap: 100, label: "113%", over: true },
      { spend: 250, cap: 100, label: "250%", over: true },
      { spend: 100, cap: 100, label: "100%", over: false },
      { spend: 99.5, cap: 100, label: "100%", over: false },
    ];
    for (const row of rows) {
      const html = htmlFor("SUPER_ADMIN", zz({ usd: row.cap, spendUsd: row.spend, percent: 0 }));
      const name = `$${row.spend.toFixed(2)} of $${row.cap.toFixed(2)}`;
      if (row.over) {
        // Visible text in the same cell as the percentage, so a screen reader reads it too.
        expect(html, name).toContain(`<dt>Percentage used</dt><dd>${row.label} <span class="usage-over">Over ceiling</span></dd>`);
        expect(html, name).toContain(`aria-valuetext="${name}, ${row.label} used, over ceiling"`);
        expect(html, name).toContain('style="width:100%"');
      } else {
        expect(html, name).toContain(`<dt>Percentage used</dt><dd>${row.label}</dd>`);
        expect(html, name).not.toContain("Over ceiling");
        expect(html, name).not.toContain("over ceiling");
      }
    }
  });
});
