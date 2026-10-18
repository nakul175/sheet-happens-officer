"use client";
import { Skeleton } from "@/components/ui";

export type UsageRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

/** What GET /api/usage returns. Messages and quick actions are separate figures (APL-2641). */
export type UsagePayload = {
  monthStart: string;
  weekStart: string;
  ceiling: { usd: number; spendUsd: number; percent: number };
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

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;

/** Bar width. The painted percentage is the API figure, which can pass 100 when calls already running finish. */
export function meterWidth(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, percent);
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

/** Spend to date, the monthly ceiling and the percentage used, taken from `ceiling` as /api/usage returns it. */
export function SpendCeiling({ ceiling }: { ceiling: UsagePayload["ceiling"] }) {
  const amount = formatUsd(ceiling.spendUsd);
  const cap = formatUsd(ceiling.usd);
  const pct = `${ceiling.percent}%`;
  const width = meterWidth(ceiling.percent);
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
