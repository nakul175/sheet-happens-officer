// APL-2950 (follow-up to APL-2519 AC6 v1.2): spend against the ceiling on the Usage screen.
// AC1 a null or missing spendUsd shows $0.00 and 0% instead of throwing. AC2 spend over the ceiling by less than
// a cent still carries the "Over ceiling" flag. AC3 (Dwight's ruling): a ceiling of 0 or unset shows "No ceiling set"
// and no percentage, and says the default $100 safety cap still applies; the cap itself is not removed.
// Render data only, named ZZ-TEST; nothing is written anywhere.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { UsageContents, formatUsd, type UsagePayload } from "@/app/(app)/usage/screen";
import { monthlyCeilingConfigured, monthlyCeilingUsd } from "@/lib/concierge/limits";

function htmlFor(ceiling: UsagePayload["ceiling"]) {
  const data: UsagePayload = {
    monthStart: "2026-09-30T18:30:00.000Z",
    weekStart: "2026-10-11T18:30:00.000Z",
    ceiling,
    month: { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 },
    people: [{ id: "zz-2950", name: "ZZ-TEST usage person", monthCalls: 1, weekCalls: 1, monthCostUsd: 0 }],
  };
  return renderToStaticMarkup(<UsageContents role="SUPER_ADMIN" loading={false} error={null} data={data} />);
}

describe("qa:TC missing APL-2950 Usage spend vs ceiling fixes", () => {
  const saved = process.env.MONTHLY_CEILING_USD;
  afterEach(() => {
    if (saved === undefined) delete process.env.MONTHLY_CEILING_USD;
    else process.env.MONTHLY_CEILING_USD = saved;
  });

  it("qa:TC missing APL-2950 AC1: a null or missing spendUsd shows $0.00 and 0% and does not throw", () => {
    expect(formatUsd(null)).toBe("$0.00");
    expect(formatUsd(undefined)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    const cases: { label: string; spendUsd: number | null | undefined }[] = [
      { label: "null", spendUsd: null },
      { label: "missing", spendUsd: undefined },
      { label: "NaN", spendUsd: Number.NaN },
    ];
    for (const c of cases) {
      const html = htmlFor({ usd: 80, spendUsd: c.spendUsd, percent: 0 });
      expect(html, c.label).toContain("<dt>Spend to date</dt><dd>$0.00</dd>");
      expect(html, c.label).toContain("<dt>Percentage used</dt><dd>0%</dd>");
      expect(html, c.label).toContain('aria-valuetext="$0.00 of $80.00, 0% used"');
      expect(html, c.label).not.toContain("Over ceiling");
      expect(html, c.label).not.toMatch(/NaN|Infinity/);
      // The no-ceiling card takes the same path.
      const none = htmlFor({ usd: 0, spendUsd: c.spendUsd, percent: 0 });
      expect(none, c.label).toContain("<dt>Spend to date</dt><dd>$0.00</dd>");
      expect(none, c.label).not.toMatch(/NaN|Infinity/);
    }
  });

  it("qa:TC missing APL-2950 AC2: spend over the ceiling by less than a cent still shows the Over ceiling flag", () => {
    for (const spend of [100.004, 100.001, 100.0001]) {
      const html = htmlFor({ usd: 100, spendUsd: spend, percent: 0 });
      expect(html, String(spend)).toContain('<dt>Percentage used</dt><dd>100% <span class="usage-over">Over ceiling</span></dd>');
      expect(html, String(spend)).toContain('aria-valuetext="$100.00 of $100.00, 100% used, over ceiling"');
    }
    // At exactly the ceiling it is not over.
    expect(htmlFor({ usd: 100, spendUsd: 100, percent: 100 })).not.toContain("Over ceiling");
  });

  it("qa:TC missing APL-2950 AC3: a ceiling of 0 or unset shows No ceiling set, no percentage, and that the default $100 safety cap applies", () => {
    for (const spendUsd of [0, 10, 150]) {
      const html = htmlFor({ usd: 100, configured: false, spendUsd, percent: 0 });
      expect(html, String(spendUsd)).toContain('<h2 class="usage-h" id="usage-ceiling">Spend to date: No ceiling set</h2>');
      expect(html, String(spendUsd)).toContain("<dt>Monthly ceiling</dt><dd>No ceiling set, default $100.00 safety cap applies</dd>");
      expect(html, String(spendUsd)).toContain(`<dt>Spend to date</dt><dd>${formatUsd(spendUsd)}</dd>`);
      expect(html, String(spendUsd)).not.toContain("Percentage used");
      expect(html, String(spendUsd)).not.toContain("%<");
      expect(html, String(spendUsd)).not.toContain('role="meter"');
      expect(html, String(spendUsd)).not.toContain("Over ceiling");
      expect(html, String(spendUsd)).not.toContain("Spend against the monthly ceiling");
    }
    // A set ceiling keeps the ceiling, the percentage and the meter.
    const set = htmlFor({ usd: 100, configured: true, spendUsd: 10, percent: 10 });
    expect(set).toContain("<dt>Monthly ceiling</dt><dd>$100.00</dd>");
    expect(set).toContain("<dt>Percentage used</dt><dd>10%</dd>");
    expect(set).not.toContain("No ceiling set");
  });

  it("qa:TC missing APL-2950 AC3: MONTHLY_CEILING_USD 0 or unset is not a set ceiling, and the $100 brake still applies", () => {
    for (const v of [undefined, "", "0", "-5", "abc"]) {
      if (v === undefined) delete process.env.MONTHLY_CEILING_USD;
      else process.env.MONTHLY_CEILING_USD = v;
      expect(monthlyCeilingConfigured(), String(v)).toBe(false);
      expect(monthlyCeilingUsd(), String(v)).toBe(100);
    }
    process.env.MONTHLY_CEILING_USD = "250";
    expect(monthlyCeilingConfigured()).toBe(true);
    expect(monthlyCeilingUsd()).toBe(250);
  });

  it("qa:TC missing SHO-3013: reaching the default $100 safety cap shows an accessible warning that the concierge is paused", () => {
    const html = htmlFor({ usd: 100, configured: false, spendUsd: 100, percent: 0 });
    // Text in the page, exposed to a screen reader as a status.
    expect(html).toContain('role="status"');
    expect(html).toContain(
      "The default $100.00 safety cap has been reached. The concierge is paused until the 1st of next month, India time.",
    );
    expect(html).not.toMatch(/NaN|Infinity/);

    // Over the cap the pause is still the truth, so the warning stays.
    expect(htmlFor({ usd: 100, configured: false, spendUsd: 150, percent: 0 })).toContain('role="status"');

    // Below the cap, a ceiling the owner set, or a payload with no cap amount: no warning.
    const quiet = [
      { usd: 100, configured: false, spendUsd: 99.99, percent: 0 },
      { usd: 100, configured: true, spendUsd: 100, percent: 100 },
      { usd: null, configured: false, spendUsd: 150, percent: 0 },
    ];
    for (const ceiling of quiet) {
      const q = htmlFor(ceiling);
      expect(q).not.toContain('role="status"');
      expect(q).not.toContain("safety cap has been reached");
    }
  });
});
