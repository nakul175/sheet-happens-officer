"use client";
import Link from "next/link";
import { ScreenViews } from "@/components/ScreenViews";
import { screenFilters, type ScreenFilters } from "@/lib/screen-view-state";
import { Skeleton } from "@/components/ui";
import { useState } from "react";
import { api, dueLabel, isOverdue, useGet } from "@/components/api";
import { ConvertDialog } from "@/components/ConvertDialog";
import { Page, useMe } from "../Shell";

type DealRow = { id: string; name: string; stage: string | null; pipeline: string | null; organisation: { id: string; name: string } | null; leader: { name: string } | null; nextStep: { title: string; dueDate: string | null } | null; lastActivity?: string };
type Idea = { id: string; title: string; dueDate: string | null; createdAt: string; assignee: { id: string; name: string }; project: { id: string; name: string }; canEdit: boolean };
type Counts = { id: string; name: string; stages: { id: string; name: string; count: number; sums: { currency: string; total: number }[]; withoutValue: number }[] }[];
type R = { needsNextStep: DealRow[]; overdueNextStep: DealRow[]; stalled: DealRow[]; ideas: Idea[]; counts: Counts };

function Deals({ title, rows, empty, red }: { title: string; rows: DealRow[]; empty: string; red?: boolean }) {
  return (
    <section aria-label={title}>
      <div className={`grp${red ? " red" : ""}`}>{title} · {rows.length}</div>
      {rows.length === 0 ? <div className="card empty">{empty}</div> : (
        <div className="list">
          {rows.map((d) => (
            <Link key={d.id} href={`/projects/${d.id}`} className="item">
              <div className="t"><b>{d.name}</b><small>{[d.organisation?.name, d.pipeline, d.stage, d.leader?.name].filter(Boolean).join(" · ")}</small></div>
              <div className="meta">{d.nextStep ? <span className={isOverdue(d.nextStep.dueDate) ? "over" : undefined}>{d.nextStep.title} · {dueLabel(d.nextStep.dueDate)}</span> : d.lastActivity ? <span>Last activity {dueLabel(d.lastActivity.slice(0, 10))}</span> : <span className="chip red">No next step</span>}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ReviewView({ initialFilters = screenFilters.parse({}), selectedView }: { initialFilters?: ScreenFilters; selectedView?: string }) {
  const [filters, setFilters] = useState(initialFilters);
  const filterQuery = new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== "" && v !== false).map(([k,v]) => [k, String(v)]));
  const pipelines = useGet<{ pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[] }>("/api/deals/pipelines");
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const me = useMe();
  void me;
  const { data, loading, error, reload } = useGet<R>(`/api/review?${filterQuery}`);
  const [conv, setConv] = useState<Idea | null>(null);
  async function drop(t: Idea) { await api("POST", `/api/tasks/${t.id}/idea`, { isIdea: false }); reload(); }
  return (
    <Page title="Pipeline review" sub="What needs a decision this week">
      <ScreenViews screen="REVIEW" state={filters} selected={selectedView} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <select className="in" aria-label="Pipeline" value={filters.pipelineId} onChange={e => setFilters({ ...filters, pipelineId: e.target.value, stageId: "" })}><option value="">All pipelines</option>{pipelines.data?.pipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select className="in" aria-label="Stage" value={filters.stageId} onChange={e => setFilters({ ...filters, stageId: e.target.value })}><option value="">All stages</option>{pipelines.data?.pipelines.filter(p => !filters.pipelineId || p.id === filters.pipelineId).flatMap(p => p.stages).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select className="in" aria-label="Organisation" value={filters.organisationId} onChange={e => setFilters({ ...filters, organisationId: e.target.value })}><option value="">All organisations</option>{orgs.data?.organisations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <select className="in" aria-label="Leader" value={filters.leaderId} onChange={e => setFilters({ ...filters, leaderId: e.target.value })}><option value="">All Leaders</option>{team.data?.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <label><input type="checkbox" checked={filters.atRisk} onChange={e => setFilters({ ...filters, atRisk: e.target.checked })} /> At risk</label>
      </div>
      {loading && !data && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && (
        <>
          <Deals title="Needs a next step" rows={data.needsNextStep} empty="Every working deal has a dated next step." red />
          <Deals title="Next step is overdue" rows={data.overdueNextStep} empty="No overdue next steps." red />
          <Deals title="Stalled for 30 days" rows={data.stalled} empty="Nothing is stalled." />
          <section aria-label="Ideas older than 30 days">
            <div className="grp">Ideas older than 30 days · {data.ideas.length}</div>
            {data.ideas.length === 0 ? <div className="card empty">No old ideas.</div> : (
              <div className="list">
                {data.ideas.map((t) => (
                  <div key={t.id} className="item" style={{ alignItems: "flex-start" }}>
                    <div className="t"><Link href={`/projects/${t.project.id}?task=${t.id}`}><b>{t.title}</b></Link><small>{t.project.name} · {t.assignee.name} · since {dueLabel(t.createdAt.slice(0, 10))}</small></div>
                    {t.canEdit && <div className="meta"><button className="btn ghost sm" onClick={() => setConv(t)}>Convert to deal</button><button className="btn ghost sm" onClick={() => drop(t)}>Drop</button></div>}
                  </div>
                ))}
              </div>
            )}
          </section>
          <div className="grp">Pipeline by stage</div>
          {data.counts.map((p) => (
            <div key={p.id} style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 14 }}>{p.name}</b>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl">
                  <thead><tr><th>Stage</th><th>Deals</th><th>Value</th></tr></thead>
                  <tbody>{p.stages.map((s) => (
                    <tr key={s.id}><td>{s.name}</td><td>{s.count}</td><td>{s.sums.length ? s.sums.map((x) => `${x.currency} ${x.total.toLocaleString("en-IN")}`).join(" · ") : "—"}{s.withoutValue ? ` · ${s.withoutValue} without value` : ""}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
      {conv && <ConvertDialog task={{ id: conv.id, title: conv.title, dueDate: conv.dueDate, assignee: conv.assignee }} meId={me.id} onClose={() => setConv(null)} />}
    </Page>
  );
}
