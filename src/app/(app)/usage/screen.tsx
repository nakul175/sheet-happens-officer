"use client";
import { Skeleton } from "@/components/ui";

export type UsageRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

/**
 * What GET /api/usage returns. `ceiling.percent` is the display string ("13%", "0%", "<1%", "120%"),
 * not a bare integer. `messages` and `quickActions` stay on the type so a later
 * section can read them; this screen does not show them (APL-2641).
 */
export type UsagePayload = {
  monthStart: string;
  weekStart: string;
  ceiling: { usd: number; spendUsd: number; percent: string };
  month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; messages?: number };
  quickActions?: { id: string; label: string; count: number }[];
  people: { id: string; name: string; monthCalls: number; weekCalls: number; monthCostUsd: number }[];
};

export const USAGE_DENIED = "This page isn't available";
export const USAGE_SUB = "Spend against the monthly ceiling, plus calls and tokens this month. Counts only; no chat text is shown here.";

export const usageAllowed = (role: UsageRole) => role === "SUPER_ADMIN";

export function usageTitle(role: UsageRole) {
  return usageAllowed(role) ? "Usage" : USAGE_DENIED;
}

/** Null skips the request, so other roles never receive the figures. */
export function usagePath(role: UsageRole): "/api/usage" | null {
  return usageAllowed(role) ? "/api/usage" : null;
}

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Bar width from the display string `/api/usage` returns.
 * The bar stops at 100. The percentage text does not.
 * "<1%" paints the true share, which stays under 1.
 */
export function meterWidth(percent: string, spendUsd = 0, ceilingUsd = 0) {
  if (percent === "<1%") {
    if (!(ceilingUsd > 0) || !(spendUsd > 0)) return 0;
    const raw = (spendUsd / ceilingUsd) * 100;
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, 0.99);
  }
  const n = Number.parseInt(percent, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

export function UsageContents({ role, loading, error, data }: {
  role: UsageRole;
  loading: boolean;
  error: string | null;
  data: UsagePayload | null;
}) {
  if (!usageAllowed(role)) return <div className="card empty">Only the Super Admin can see usage.</div>;
  return (
    <>
      {loading && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && (
        <>
          <SpendCeiling ceiling={data.ceiling} />
          <MonthCounts month={data.month} />
          <PeopleUsage people={data.people} />
        </>
      )}
    </>
  );
}

/** Spend to date, the monthly ceiling and the percentage used. `percent` is the display string `/api/usage` returns; this does not add another % sign. */
export function SpendCeiling({ ceiling }: { ceiling: UsagePayload["ceiling"] }) {
  const amount = formatUsd(ceiling.spendUsd);
  const cap = formatUsd(ceiling.usd);
  const pct = ceiling.percent;
  const width = meterWidth(ceiling.percent, ceiling.spendUsd, ceiling.usd);
  return (
    <section className="card">
      <h2 className="usage-h" id="usage-ceiling">Spend against the monthly ceiling</h2>
      <dl className="usage-figs">
        <div><dt>Spend to date</dt><dd>{amount}</dd></div>
        <div><dt>Monthly ceiling</dt><dd>{cap}</dd></div>
        <div><dt>Percentage used</dt><dd>{pct}</dd></div>
      </dl>
      <div
        className="usage-meter"
        role="meter"
        aria-labelledby="usage-ceiling"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-valuetext={`${amount} of ${cap}, ${pct} used`}
      >
        <span style={{ width: `${width}%` }} />
      </div>
    </section>
  );
}

function MonthCounts({ month }: { month: UsagePayload["month"] }) {
  return (
    <div className="cards" style={{ marginTop: 14 }}>
      <div className="card"><small>Calls this month</small><div className="stat">{month.calls}</div></div>
      <div className="card"><small>Tokens in / out</small><div className="stat">{month.inputTokens.toLocaleString("en-IN")} / {month.outputTokens.toLocaleString("en-IN")}</div></div>
    </div>
  );
}

function PeopleUsage({ people }: { people: UsagePayload["people"] }) {
  if (!people.length) return <div className="card empty" style={{ marginTop: 14 }}>No assistant use yet. The assistant is not switched on.</div>;
  return (
    <div className="scroll" style={{ marginTop: 14 }}>
      <table className="tbl stack">
        <thead><tr><th>Person</th><th>Calls this week</th><th>Calls this month</th><th>Cost this month</th></tr></thead>
        <tbody>{people.map((p) => <tr key={p.id}><td data-label="Person">{p.name}</td><td data-label="This week">{p.weekCalls}</td><td data-label="This month">{p.monthCalls}</td><td data-label="Cost this month">${p.monthCostUsd.toFixed(2)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
