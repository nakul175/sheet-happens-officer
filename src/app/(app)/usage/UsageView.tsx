"use client";
import { useGet } from "@/components/api";
import { Skeleton } from "@/components/ui";
import { Page, useMe } from "../Shell";

type Res = {
  monthStart: string; weekStart: string;
  month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  people: { id: string; name: string; monthCalls: number; weekCalls: number; monthCostUsd: number }[];
};

export default function UsageView() {
  const me = useMe();
  const u = useGet<Res>(me.orgRole === "SUPER_ADMIN" ? "/api/usage" : null);
  if (me.orgRole !== "SUPER_ADMIN") return <Page title="This page isn't available"><div className="card empty">Only the Super Admin can see usage.</div></Page>;
  const m = u.data?.month;
  return (
    <Page title="Usage" sub="Assistant calls, tokens and cost this month. Counts only; no chat text is shown here.">
      {u.loading && <Skeleton />}
      {u.error && <div className="err" role="alert">{u.error}</div>}
      {m && (
        <>
          <div className="cards">
            <div className="card"><small>Calls this month</small><div className="stat">{m.calls}</div></div>
            <div className="card"><small>Tokens in / out</small><div className="stat">{m.inputTokens.toLocaleString("en-IN")} / {m.outputTokens.toLocaleString("en-IN")}</div></div>
            <div className="card"><small>Cost this month (USD)</small><div className="stat">${m.costUsd.toFixed(2)}</div></div>
          </div>
          {!u.data!.people.length && <div className="card empty" style={{ marginTop: 14 }}>No assistant use yet. The assistant is not switched on.</div>}
          {!!u.data!.people.length && (
            <div className="scroll" style={{ marginTop: 14 }}>
              <table className="tbl stack">
                <thead><tr><th>Person</th><th>Calls this week</th><th>Calls this month</th><th>Cost this month</th></tr></thead>
                <tbody>{u.data!.people.map((p) => <tr key={p.id}><td data-label="Person">{p.name}</td><td data-label="This week">{p.weekCalls}</td><td data-label="This month">{p.monthCalls}</td><td data-label="Cost this month">${p.monthCostUsd.toFixed(2)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
