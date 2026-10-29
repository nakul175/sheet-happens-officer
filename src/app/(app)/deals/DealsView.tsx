"use client";
import Link from "next/link";
import { ScreenViews } from "@/components/ScreenViews";
import { screenFilters, type ScreenFilters } from "@/lib/screen-view-state";
import { Skeleton } from "@/components/ui";
import { useState } from "react";
import { dueLabel, isOverdue, useGet } from "@/components/api";
import { money } from "@/components/DealPanel";
import { DealBoard, type BoardDeal, type BoardStage } from "@/components/DealBoard";
import { Page, useMe } from "../Shell";

type D = BoardDeal;

export default function DealsView({ initialFilters = screenFilters.parse({}), selectedView }: { initialFilters?: ScreenFilters; selectedView?: string }) {
  const [stageId, setStageId] = useState(initialFilters.stageId);
  const [organisationId, setOrganisationId] = useState(initialFilters.organisationId);
  const [leaderId, setLeaderId] = useState(initialFilters.leaderId);
  const [atRisk, setAtRisk] = useState(initialFilters.atRisk);
  const [mine, setMine] = useState(initialFilters.mine);
  const [old, setOld] = useState(initialFilters.archived);
  const [view, setView] = useState<"board" | "list">(initialFilters.layout);
  const [pipe, setPipe] = useState(initialFilters.pipelineId);
  const me = useMe();
  void me;
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string; stages: BoardStage[] }[] }>("/api/deals/pipelines");
  const cur = pipes.data?.pipelines.find((p) => p.id === pipe) ?? pipes.data?.pipelines[0];
  const { data, loading, error, reload } = useGet<{ deals: D[] }>(cur ? `/api/deals?pipelineId=${cur.id}${mine ? "&mine=true" : ""}${old ? "&archived=true" : ""}` : null);
  const allDeals = data?.deals ?? [];
  const deals = allDeals.filter(d => (!stageId || d.stage?.id === stageId) && (!organisationId || d.organisation?.id === organisationId) && (!leaderId || d.leader?.id === leaderId) && (!atRisk || d.stalled || d.needsNextStep || (d.nextStep?.dueDate && isOverdue(d.nextStep.dueDate))));
  const organisations = [...new Map(allDeals.flatMap(d => d.organisation ? [[d.organisation.id, d.organisation] as const] : [])).values()];
  const leaders = [...new Map(allDeals.flatMap(d => d.leader ? [[d.leader.id, d.leader] as const] : [])).values()];
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
      <ScreenViews screen="DEALS" selected={selectedView} state={{ ...initialFilters, pipelineId: cur?.id ?? "", stageId, organisationId, leaderId, atRisk, mine, archived: old, layout: view }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <select className="in" aria-label="Stage" value={stageId} onChange={e => setStageId(e.target.value)}><option value="">All stages</option>{cur?.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select className="in" aria-label="Organisation" value={organisationId} onChange={e => setOrganisationId(e.target.value)}><option value="">All organisations</option>{organisations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <select className="in" aria-label="Leader" value={leaderId} onChange={e => setLeaderId(e.target.value)}><option value="">All Leaders</option>{leaders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <label><input type="checkbox" checked={atRisk} onChange={e => setAtRisk(e.target.checked)} /> At risk</label>
      </div>
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist" aria-label="Pipeline">
          {pipes.data?.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={cur?.id === p.id} onClick={() => { setPipe(p.id); setStageId(""); }}>{p.name}</button>)}
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
      {data && cur && view === "board" && !old && <DealBoard deals={deals} stages={cur.stages} bid={cur.key === "DEAL_BID"} onChange={reload} />}
      {deals.length > 0 && (view === "list" || old) && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Deal</th><th>Organisation</th><th>Stage</th><th>Value</th><th>Next step</th><th>Leader</th></tr></thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/projects/${d.id}`}>{d.name}</Link> {d.stalled && <span className="chip gold">Stalled</span>}</td>
                  <td>{d.organisation ? <Link href={`/accounts/${d.organisation.id}`}>{d.organisation.name}</Link> : "—"}</td>
                  <td><span className="chip">{d.stage?.name}</span><div style={{ fontSize: 12, color: "var(--muted)" }}>{d.pipeline?.name}</div></td>
                  <td>{money(d.value, d.currency)}</td>
                  <td>{d.nextStep ? <>{d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">None</span> : "—"}</td>
                  <td>{d.leader?.name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
