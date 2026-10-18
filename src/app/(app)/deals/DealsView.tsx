"use client";
import Link from "next/link";
import { Skeleton } from "@/components/ui";
import { useState } from "react";
import { dueLabel, isOverdue, useGet } from "@/components/api";
import { money } from "@/components/DealPanel";
import { CategoryBoard, DealBoard, type BoardDeal, type BoardStage } from "@/components/DealBoard";
import { StagesDialog } from "@/components/StagesDialog";
import { Page, useMe } from "../Shell";

type D = BoardDeal;

export default function DealsView() {
  const [mine, setMine] = useState(false);
  const [old, setOld] = useState(false);
  const [view, setView] = useState<"board" | "category" | "list">("board");
  const [pipe, setPipe] = useState("");
  const me = useMe();
  const [stagesOpen, setStagesOpen] = useState(false);
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string; stages: BoardStage[] }[] }>("/api/deals/pipelines");
  const cur = pipes.data?.pipelines.find((p) => p.id === pipe) ?? pipes.data?.pipelines[0];
  const { data, loading, error, reload } = useGet<{ deals: D[] }>(cur ? `/api/deals?${view === "category" ? "" : `pipelineId=${cur.id}`}${mine ? "&mine=true" : ""}${old ? "&archived=true" : ""}` : null);
  const deals = data?.deals ?? [];
  return (
    <Page title="Deals" sub="Deals you lead or belong to"
      actions={<>
        <div className="seg" role="group" aria-label="Which deals">
          <button aria-pressed={!mine} onClick={() => setMine(false)}>All mine</button>
          <button aria-pressed={mine} onClick={() => setMine(true)}>Only my deals</button>
        </div>
        <button className="btn ghost" aria-pressed={old} onClick={() => setOld(!old)}>{old ? "Show live" : "Show archived"}</button>
        {me.orgRole === "SUPER_ADMIN" && cur && <button className="btn ghost" onClick={() => setStagesOpen(true)}>Edit stages</button>}
        <Link className="btn" href="/deals/new">+ New deal</Link>
      </>}>
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist" aria-label="Pipeline">
          {pipes.data?.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={cur?.id === p.id} onClick={() => setPipe(p.id)}>{p.name}</button>)}
        </div>
        <span className="sp" />
        <div className="seg" role="group" aria-label="Layout">
          <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button aria-pressed={view === "category"} onClick={() => setView("category")}>By category</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>
      {loading && !data && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && deals.length === 0 && <div className="card empty"><b>No deals yet.</b><br />Create one to track an opportunity.<div className="empty-act"><Link className="btn" href="/deals/new">New deal</Link></div></div>}
      {data && cur && view === "board" && !old && <DealBoard deals={deals} stages={cur.stages} bid={cur.key === "DEAL_BID"} onChange={reload} />}
      {data && view === "category" && !old && <CategoryBoard deals={deals} />}
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
      {stagesOpen && cur && <StagesDialog pipeline={cur} onClose={() => setStagesOpen(false)} onDone={() => { pipes.reload(); reload(); }} />}
    </Page>
  );
}
