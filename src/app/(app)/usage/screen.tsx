"use client";
import { Skeleton } from "@/components/ui";
import { NO_CEILING, OVER_CEILING, hasCeiling, overCeiling, percentUsedLabel } from "@/lib/usage-percent";

export type UsageRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

/**
 * What GET /api/usage returns. `ceiling.percent` is a whole number (0 when the label is "0%" or "<1%").
 * The screen prints percentUsedLabel(spend, ceiling) and does not echo that number, so an old one-decimal
 * percent still shows 13% for 10 of 80 and "<1%" for 1 of 101.
 * A ceiling of 0 or unset (`usd` 0, null or missing) shows "No ceiling set" and no percentage (AC6 v1.1).
 * Messages and quick actions are separate figures (APL-2641).
 */
export type UsagePayload = {
  monthStart: string;
  weekStart: string;
  ceiling: { usd?: number | null; configured?: boolean; spendUsd?: number | null; percent: number };
  month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; messages?: number };
  quickActions?: { id: string; label: string; count: number }[];
  people: { id: string; name: string; monthCalls: number; weekCalls: number; monthCostUsd: number }[];
};

export const USAGE_DENIED = "This page isn't available";
export const USAGE_SUB = "Spend against the monthly ceiling, messages and quick actions this month, plus calls and tokens. Counts only; no chat text is shown here.";

export const usageAllowed = (role: UsageRole) => role === "SUPER_ADMIN";

export function usageTitle(role: UsageRole) {
  return usageAllowed(role) ? "Usage" : USAGE_DENIED;
}

/** Null skips the request, so other roles never receive the figures. */
export function usagePath(role: UsageRole): "/api/usage" | null {
  return usageAllowed(role) ? "/api/usage" : null;
}

/** A missing, null or non-finite amount is $0.00 (APL-2950). */
export const usdAmount = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
export const formatUsd = (n: number | null | undefined) => `$${usdAmount(n).toFixed(2)}`;

/**
 * Bar width from the display label. The bar stops at 100. The percentage text does not.
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
          <div className="usage-split">
            <SpendCeiling ceiling={data.ceiling} />
            <MessagesThisMonth messages={data.month.messages ?? 0} />
            <QuickActionCounts actions={data.quickActions ?? []} />
          </div>
          <MonthCounts month={data.month} />
          <PeopleUsage people={data.people} />
        </>
      )}
    </>
  );
}

/**
 * Spend to date, the monthly ceiling and the percentage used. The label comes from spend and ceiling, not from `ceiling.percent`.
 * No ceiling: "No ceiling set", no percentage and no meter. Over the ceiling: the rounded percentage plus a
 * visible "Over ceiling" flag, in text so it does not rely on colour (AC6 v1.1).
 */
export function SpendCeiling({ ceiling }: { ceiling: UsagePayload["ceiling"] }) {
  const spend = usdAmount(ceiling.spendUsd);
  const amount = formatUsd(spend);
  // AC6 v1.2: a ceiling of 0 or unset shows "No ceiling set" and no percentage. The $100 safety cap still
  // applies, so the screen says so instead of passing it off as a set ceiling (APL-2950, Dwight's ruling).
  if (ceiling.configured === false || !hasCeiling(ceiling.usd)) {
    const safetyCap = hasCeiling(ceiling.usd) ? `, default ${formatUsd(ceiling.usd)} safety cap applies` : "";
    // SHO-3013: with no set ceiling the default $100 safety cap is the brake. The concierge stops at 100 percent
    // (monthCap stops at >=), so say so in text when spend reaches the cap instead of leaving the screen silent.
    // role="status" gives the sentence to a screen reader; the wording does not rely on colour.
    const capUsd = hasCeiling(ceiling.usd) ? ceiling.usd : null;
    const capReached = ceiling.configured === false && capUsd !== null && spend >= capUsd;
    return (
      <section className="card">
        <h2 className="usage-h" id="usage-ceiling">Spend to date: {NO_CEILING}</h2>
        <dl className="usage-figs">
          <div><dt>Spend to date</dt><dd>{amount}</dd></div>
          <div><dt>Monthly ceiling</dt><dd>{NO_CEILING}{safetyCap}</dd></div>
        </dl>
        {capReached && (
          <p className="usage-warn" role="status">
            The default {formatUsd(capUsd)} safety cap has been reached. The concierge is paused until the 1st of next month, India time.
          </p>
        )}
      </section>
    );
  }
  const cap = formatUsd(ceiling.usd);
  const pct = percentUsedLabel(spend, ceiling.usd) ?? "0%";
  const over = overCeiling(spend, ceiling.usd);
  const width = meterWidth(pct, spend, ceiling.usd);
  return (
    <section className="card">
      <h2 className="usage-h" id="usage-ceiling">Spend against the monthly ceiling</h2>
      <dl className="usage-figs">
        <div><dt>Spend to date</dt><dd>{amount}</dd></div>
        <div><dt>Monthly ceiling</dt><dd>{cap}</dd></div>
        <div><dt>Percentage used</dt><dd>{pct}{over && <> <span className="usage-over">{OVER_CEILING}</span></>}</dd></div>
      </dl>
      <div
        className="usage-meter"
        role="meter"
        aria-labelledby="usage-ceiling"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-valuetext={`${amount} of ${cap}, ${pct} used${over ? `, ${OVER_CEILING.toLowerCase()}` : ""}`}
      >
        <span style={{ width: `${width}%` }} />
      </div>
    </section>
  );
}

/** Total concierge messages this calendar month, as /api/usage counted them. Quick actions are not in this number. */
export function MessagesThisMonth({ messages }: { messages: number }) {
  const n = messages.toLocaleString("en-IN");
  return (
    <section className="card" aria-labelledby="usage-messages">
      <h2 className="usage-h" id="usage-messages">Messages this month</h2>
      <p className="usage-count">{n}</p>
      <p className="hint">This calendar month, India time. Quick actions are not included.</p>
    </section>
  );
}

/** Each quick action's own count for the same month. These stay out of the message total. */
export function QuickActionCounts({ actions }: { actions: NonNullable<UsagePayload["quickActions"]> }) {
  return (
    <section className="card" aria-labelledby="usage-quick">
      <h2 className="usage-h" id="usage-quick">Quick actions this month</h2>
      {actions.length === 0 ? <p className="hint">No quick actions this month.</p> : (
        <dl className="usage-figs">
          {actions.map((q) => <div key={q.id}><dt>{q.label}</dt><dd>{q.count.toLocaleString("en-IN")}</dd></div>)}
        </dl>
      )}
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
