"use client";
import Link from "next/link";
import { Skeleton } from "@/components/ui";
import { useState } from "react";
import { api, dueLabel, isOverdue, useGet } from "@/components/api";
import { ConvertDialog } from "@/components/ConvertDialog";
import { Page, useMe } from "../Shell";

type DealRow = { id: string; name: string; stage: string | null; pipeline: string | null; organisation: { id: string; name: string } | null; leader: { name: string } | null; nextStep: { title: string; dueDate: string | null } | null; lastActivity?: string };
type Idea = { id: string; title: string; dueDate: string | null; createdAt: string; assignee: { id: string; name: string }; project: { id: string; name: string }; canEdit: boolean };
type Counts = { id: string; name: string; stages: { id: string; name: string; count: number; sums: { currency: string; total: number }[]; withoutValue: number }[] }[];
type R = { needsNextStep: DealRow[]; overdueNextStep: DealRow[]; stalled: DealRow[]; ideas: Idea[]; counts: Counts; otherCounts: Counts; unclassifiedCounts: Counts };

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

export default function ReviewView() {
  const me = useMe();
  void me;
  const { data, loading, error, reload } = useGet<R>("/api/review");
  const [conv, setConv] = useState<Idea | null>(null);
  async function drop(t: Idea) { await api("POST", `/api/tasks/${t.id}/idea`, { isIdea: false }); reload(); }
  return (
    <Page title="Pipeline review" sub="What needs a decision this week">
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
          <StageCounts title="Commercial pipeline by stage · RFP/RFA + OTC" counts={data.counts} />
          <StageCounts title="Other opportunities by stage · EOI + CV/LTA" counts={data.otherCounts ?? []} />
          <StageCounts title="Unclassified opportunities by stage" counts={data.unclassifiedCounts ?? []} />
        </>
      )}
      {conv && <ConvertDialog task={{ id: conv.id, title: conv.title, dueDate: conv.dueDate, assignee: conv.assignee }} meId={me.id} onClose={() => setConv(null)} />}
    </Page>
  );
}

function StageCounts({ title, counts }: { title: string; counts: Counts }) {
  return <section aria-label={title}>
    <div className="grp">{title}</div>
    {counts.map(p => <div key={p.id} style={{ marginBottom: 12 }}>
      <b style={{ fontSize: 14 }}>{p.name}</b>
      <div style={{ overflowX: "auto" }}><table className="tbl">
        <thead><tr><th>Stage</th><th>Deals</th><th>Value</th></tr></thead>
        <tbody>{p.stages.map(s => <tr key={s.id}><td>{s.name}</td><td>{s.count}</td><td>{s.sums.length ? s.sums.map(x => `${x.currency} ${x.total.toLocaleString("en-IN")}`).join(" · ") : "—"}{s.withoutValue ? ` · ${s.withoutValue} without value` : ""}</td></tr>)}</tbody>
      </table></div>
    </div>)}
  </section>;
}
