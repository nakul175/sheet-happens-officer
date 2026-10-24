"use client";
import Link from "next/link";
import { Skeleton } from "@/components/ui";
import { useState } from "react";
import { dueLabel, isOverdue, useGet } from "@/components/api";
import { OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { money } from "@/components/DealPanel";
import { DealBoard, inLifecycle, opportunityGroups, totals, type BoardDeal, type BoardStage } from "@/components/DealBoard";
import { Page, useMe } from "../Shell";

type D = BoardDeal;

export default function DealsView() {
  const [lifecycle, setLifecycle] = useState<"sales" | "delivery">("sales");
  const [mine, setMine] = useState(false);
  const [old, setOld] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [pipe, setPipe] = useState("");
  const me = useMe();
  void me;
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string; stages: BoardStage[] }[] }>("/api/deals/pipelines");
  const cur = pipes.data?.pipelines.find((p) => p.id === pipe) ?? pipes.data?.pipelines[0];
  const { data, loading, error, reload } = useGet<{ deals: D[] }>(cur ? `/api/deals?pipelineId=${cur.id}&lifecycle=${lifecycle}${mine ? "&mine=true" : ""}${old ? "&archived=true" : ""}` : null);
  const deals = (data?.deals ?? []).filter(d => inLifecycle(d, lifecycle));
  const groups = opportunityGroups(deals);
  const openCommercial = groups[0].deals.filter(d => ["NOT_STARTED", "ACTIVE", "PAUSED"].includes(d.stage?.category ?? ""));
  const openTotals = totals(openCommercial);
  return (
    <Page title="Deals" sub="Deals you lead or belong to"
      actions={<>
        <div className="seg" role="group" aria-label="Which deals">
          <button aria-pressed={!mine} onClick={() => setMine(false)}>All mine</button>
          <button aria-pressed={mine} onClick={() => setMine(true)}>Only my deals</button>
        </div>
        <button className="btn ghost" aria-pressed={old} onClick={() => setOld(!old)}>{old ? "Show live" : "Show archived"}</button>
        <Link className="btn" href="/deals/new">+ New deal</Link>
      </>}>
      <div className="seg" role="group" aria-label="Deal lifecycle" style={{ marginBottom: 12 }}>
        <button aria-pressed={lifecycle === "sales"} onClick={() => setLifecycle("sales")}>Sales pipeline</button>
        <button aria-pressed={lifecycle === "delivery"} onClick={() => setLifecycle("delivery")}>Delivery projects</button>
      </div>
      {data && lifecycle === "sales" && <div className="card" role="region" aria-label="Open commercial pipeline" style={{ marginBottom: 12 }}>
        <b>{old ? "Archived open-stage" : "Open"} RFP/RFA + OTC: {openCommercial.length}</b>
        <div className="sub">Includes not-started, active and paused sales stages; excludes Won, Lost, No-Go and delivery.</div>
        <div>{openTotals.sums.length ? openTotals.sums.join(" · ") : "No values"}{openTotals.unknown ? ` · ${openTotals.unknown} without value` : ""}</div>
      </div>}
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist" aria-label="Pipeline">
          {pipes.data?.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={cur?.id === p.id} onClick={() => setPipe(p.id)}>{p.name}</button>)}
        </div>
        <span className="sp" />
        <div className="seg" role="group" aria-label="Layout">
          <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>
      {loading && !data && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && deals.length === 0 && <div className="card empty"><b>No deals yet.</b><br />Create one to track an opportunity.<div className="empty-act"><Link className="btn" href="/deals/new">New deal</Link></div></div>}
      {data && cur && groups.map(group => {
        const t = totals(group.deals);
        return <section key={group.key} aria-label={`${group.label} ${lifecycle}`} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18 }}>{group.label} · {group.deals.length} {lifecycle === "delivery" ? "delivery projects" : "deals"}</h2>
          <p className="sub">{lifecycle === "delivery" ? "Delivery only; excluded from sales pipeline counts." : "All shown sales stages, including outcomes."} {t.sums.join(" · ")}{t.unknown > 0 ? ` · ${t.unknown} without value` : ""}</p>
          {group.deals.length === 0 ? <p className="sub">No {group.label} {lifecycle === "delivery" ? "delivery projects" : "deals"}.</p>
            : view === "board" && !old ? <DealBoard deals={group.deals} stages={cur.stages} lifecycle={lifecycle} bid={cur.key === "DEAL_BID"} onChange={reload} />
            : <DealList deals={group.deals} />}
        </section>;
      })}

    </Page>
  );
}

function DealList({ deals }: { deals: D[] }) {
  return <div style={{ overflowX: "auto" }}><table className="tbl">
    <thead><tr><th>Deal</th><th>Opportunity type</th><th>Organisation</th><th>Stage</th><th>Value</th><th>Next step</th><th>Leader</th></tr></thead>
    <tbody>{deals.map(d => <tr key={d.id}>
      <td><Link href={`/projects/${d.id}`}>{d.name}</Link> {d.stalled && <span className="chip gold">Stalled</span>}</td>
      <td>{OPPORTUNITY_TYPES.find(o => o.value === d.opportunityType)?.label ?? "Unclassified"}</td>
      <td>{d.organisation ? <Link href={`/accounts/${d.organisation.id}`}>{d.organisation.name}</Link> : "—"}</td>
      <td><span className="chip">{d.stage?.name}{d.stage?.isRetired ? " · legacy stage" : ""}</span><div style={{ fontSize: 12, color: "var(--muted)" }}>{d.pipeline?.name}</div></td>
      <td>{money(d.value, d.currency)}</td>
      <td>{d.nextStep ? <>{d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">None</span> : "—"}</td>
      <td>{d.leader?.name ?? "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}
