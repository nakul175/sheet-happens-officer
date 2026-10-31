"use client";
// SHO-US-10.5 / 12.6: one shared view of deals. Every active stage has its own column.
// SHO-3133: On hold, Won and Lost stay visually distinct in Proactive and Bid; responsive CSS wraps columns.
import Link from "next/link";
import { OPPORTUNITY_TYPES, type OpportunityType } from "@/lib/deal-classification";
import { useMemo, useState } from "react";
import { api, dueLabel, isOverdue } from "@/components/api";
import { Blocked, StageDialog, money, type Stage, type StageInitial } from "@/components/DealPanel";
import { Menu, Modal } from "@/components/ui";
import { DealBdFacts, type BdValues } from "@/components/DealBdFields";

export type BoardDeal = BdValues & {
  id: string; name: string; archived: boolean; pipeline: { id: string; key: string; name: string } | null; stage: { id: string; name: string; category: string; isRetired?: boolean } | null;
  organisation: { id: string; name: string } | null; leader: { id: string; name: string } | null; value: number | null; currency: string | null;
  opportunityType?: OpportunityType | null; lifecycle?: "sales" | "delivery";
  expectedClose?: string | null; createdAt?: string | null; stageChangedAt?: string | null;
  submissionDeadline: string | null; nextStep: { title: string; dueDate: string | null } | null; needsNextStep: boolean; stalled: boolean;
};
export type BoardStage = Stage & { id: string; name: string; category: string };
type Col = { key: string; title: string; stages: BoardStage[]; deals: BoardDeal[] };


export type DealLifecycle = "sales" | "delivery" | "all";
export type DealSort = "name-asc" | "name-desc" | "stage" | "date-asc" | "date-desc";
export function inLifecycle(d: BoardDeal, lifecycle: DealLifecycle) {
  return lifecycle === "all" || (d.stage?.category === "DELIVERY" ? "delivery" : "sales") === lifecycle;
}

export function sortDeals(deals: BoardDeal[], sort: DealSort, stages: BoardStage[]) {
  const stageOrder = new Map(stages.map((stage, index) => [stage.id, index]));
  return [...deals].sort((a, b) => {
    let result = 0;
    if (sort === "name-asc" || sort === "name-desc") result = a.name.localeCompare(b.name, "en", { sensitivity: "base" }) * (sort === "name-desc" ? -1 : 1);
    if (sort === "stage") result = (stageOrder.get(a.stage?.id ?? "") ?? Number.MAX_SAFE_INTEGER) - (stageOrder.get(b.stage?.id ?? "") ?? Number.MAX_SAFE_INTEGER);
    if (sort === "date-asc" || sort === "date-desc") {
      const ad = a.submissionDeadline;
      const bd = b.submissionDeadline;
      if (ad && bd) result = ad.localeCompare(bd) * (sort === "date-desc" ? -1 : 1);
      else if (Boolean(ad) !== Boolean(bd)) result = ad ? -1 : 1;
    }
    return result || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export function columnsFor(stages: BoardStage[], deals: BoardDeal[], bid: boolean, lifecycle: DealLifecycle = "all", sort?: DealSort): Col[] {
  const active = stages.filter(s => !s.isRetired && (lifecycle === "all" || (s.category === "DELIVERY" ? "delivery" : "sales") === lifecycle));
  const cols: Col[] = active.map(s => ({ key: s.id, title: s.name, stages: [s], deals: [] }));
  for (const d of deals) {
    if (d.archived || !d.stage || !inLifecycle(d, lifecycle)) continue;
    const c = cols.find(c => c.stages.some(s => s.id === d.stage!.id));
    c?.deals.push(d);
  }
  for (const c of cols) {
    if (sort) c.deals = sortDeals(c.deals, sort, stages);
    else if (bid) c.deals.sort((a, b) => (a.submissionDeadline ?? "9999").localeCompare(b.submissionDeadline ?? "9999"));
  }
  return cols;
}

export const OPPORTUNITY_GROUPS = [
  { key: "commercial", label: "RFP/RFA + OTC", types: ["RFP_RFA", "OTC"] },
  { key: "other", label: "EOI + CV/LTA", types: ["EOI", "CV_LTA"] },
  { key: "unclassified", label: "Unclassified", types: [] },
] as const;
export function opportunityGroups(deals: BoardDeal[]) {
  return OPPORTUNITY_GROUPS.map(group => ({ ...group, deals: deals.filter(d => group.key === "unclassified" ? opportunityFilterValue(d.opportunityType) === "unclassified" : (group.types as readonly string[]).includes(d.opportunityType ?? "")) }));
}
export const opportunityFilterValue = (value?: string | null) => OPPORTUNITY_TYPES.some(type => type.value === value) ? value! : "unclassified";

export function totals(deals: BoardDeal[]) {
  const sums = new Map<string, number>();
  let unknown = 0;
  for (const d of deals) {
    if (d.value === null || !d.currency) unknown++;
    else sums.set(d.currency, (sums.get(d.currency) ?? 0) + d.value);
  }
  return { sums: [...sums].map(([c, v]) => `${c} ${v.toLocaleString("en-IN")}`), unknown };
}

function Card({ d, stages, onMove, bid, canMove }: { d: BoardDeal; stages: BoardStage[]; onMove: (d: BoardDeal, s: BoardStage) => void; bid: boolean; canMove: boolean }) {
  return (
    <div className="dcard" draggable={canMove} onDragStart={(e) => e.dataTransfer.setData("text/deal", d.id)}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
        <Link href={`/projects/${d.id}`}><b>{d.name}</b></Link>
        {canMove && <Menu label={`Move ${d.name}`}>{(close) => (
          <>
            <div className="mhead">Move to…</div>
            {stages.filter((s) => !s.isRetired && s.id !== d.stage?.id).map((s) => <button key={s.id} role="menuitem" onClick={() => { close(); onMove(d, s); }}>{s.name}</button>)}
          </>
        )}</Menu>}
      </div>
      <div className="sub2">{OPPORTUNITY_TYPES.find(o => o.value === d.opportunityType)?.label ?? "Unclassified"}</div>
      {d.stage?.isRetired && <div className="sub2">{d.stage.name} · legacy stage</div>}
      {d.organisation && <div className="sub2">{d.organisation.name}</div>}
      <div className="sub2">{money(d.value, d.currency)}{d.leader ? ` · ${d.leader.name}` : ""}</div>
      <div className="sub2"><DealBdFacts values={d} /></div>
      {bid && d.submissionDeadline && <div className={`sub2${isOverdue(d.submissionDeadline) ? " over" : ""}`}>{isOverdue(d.submissionDeadline) ? "Deadline passed " : "Submit by "}{dueLabel(d.submissionDeadline)}</div>}
      <div className="sub2">
        {d.nextStep ? <>Next: {d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">Needs a next step</span> : null}
        {d.stalled && <span className="chip gold" style={{ marginLeft: 4 }}>Stalled</span>}
      </div>
    </div>
  );
}

export function DealBoard({ deals, stages, bid, lifecycle = "all", sort = "stage", canMove = true, onChange }: { deals: BoardDeal[]; stages: BoardStage[]; bid: boolean; lifecycle?: DealLifecycle; sort?: DealSort; canMove?: boolean; onChange: () => void }) {
  const legacy = deals.filter(d => !d.archived && d.stage?.isRetired && inLifecycle(d, lifecycle));
  const cols = useMemo(() => columnsFor(stages, deals, bid, lifecycle, sort), [stages, deals, bid, lifecycle, sort]);
  const unplaced = sortDeals(deals.filter(d => !d.archived && !d.stage?.isRetired && inLifecycle(d, lifecycle) && !cols.some(c => c.deals.some(item => item.id === d.id))), sort, stages);
  const [dialog, setDialog] = useState<null | { deal: BoardDeal; stage: BoardStage; initial?: StageInitial }>(null);
  const [which, setWhich] = useState<null | { deal: BoardDeal; stages: BoardStage[] }>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function move(d: BoardDeal, s: BoardStage) {
    setErr(null);
    if (!canMove || s.isRetired || d.stage?.id === s.id) return;
    if (s.needsReason) { setDialog({ deal: d, stage: s }); return; }
    const r = await api("POST", `/api/projects/${d.id}/stage`, { stageId: s.id, expectedStageId: d.stage?.id ?? null });
    if (r.ok) { onChange(); return; }
    const blocked: Blocked | null = r.data?.openTasks ? { openTasks: r.data.openTasks, tasks: r.data.tasks ?? [] } : null;
    if (blocked || r.data?.needsFields) setDialog({ deal: d, stage: s, initial: { err: r.error, blocked, need: r.data?.needsFields } });
    else setErr(r.error ?? "Could not move the deal.");
  }
  function drop(c: Col, id: string) {
    const d = deals.find((x) => x.id === id);
    if (!d || !canMove || c.stages.length === 0) return;
    if (c.stages.length === 1) void move(d, c.stages[0]);
    else setWhich({ deal: d, stages: c.stages.filter((s) => s.id !== d.stage?.id) });
  }
  return (
    <>
      {err && <div className="err" role="alert">{err}</div>}
      {legacy.length > 0 && <section className="card" aria-label="Legacy stage deals" style={{ marginBottom: 12 }}>
        <h3>Legacy stage restored by Undo</h3>
        <p className="sub">These deals retain their historical stage. Move to an active stage to return them to the board.</p>
        {legacy.map(d => <Card key={d.id} d={d} stages={stages} onMove={move} bid={bid} canMove={canMove} />)}
      </section>}
      {unplaced.length > 0 && <section className="card" aria-label="Unassigned stage deals" style={{ marginBottom: 12 }}><h3>Unassigned stage</h3><p className="hint">These deals have no available stage and remain accessible here.</p>{unplaced.map(d => <Card key={d.id} d={d} stages={stages} onMove={move} bid={bid} canMove={canMove} />)}</section>}
      <div className="dboard" role="region" aria-label="Deal board" tabIndex={0}>
        {cols.map((c) => {
          const t = totals(c.deals);
          return (
            <section key={c.key} className={`dcol${over === c.key ? " over" : ""}`} aria-label={c.title}
              onDragOver={(e) => { if (canMove && c.stages.length) { e.preventDefault(); setOver(c.key); } }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/deal"); if (id) drop(c, id); }}>
              <header>
                <b>{c.title}</b> <span className="chip grey">{c.deals.length}</span>
                <div className="sub2">{t.sums.length ? t.sums.join(" · ") : "No values"}{t.unknown > 0 ? ` · ${t.unknown} without value` : ""}</div>
              </header>
              {c.deals.map((d) => <Card key={d.id} d={d} stages={stages} onMove={move} bid={bid} canMove={canMove} />)}
              {c.deals.length === 0 && <div className="sub2" style={{ padding: 8 }}>No deals</div>}
            </section>
          );
        })}
      </div>
      {which && (
        <Modal small label="Move to which stage?" onClose={() => setWhich(null)}>
          <h2>Move to which stage?</h2>
          <div style={{ display: "grid", gap: 6 }}>
            {which.stages.map((s) => <button key={s.id} className="btn ghost" onClick={() => { const w = which; setWhich(null); setDialog({ deal: w.deal, stage: s }); }}>{s.name}</button>)}
          </div>
        </Modal>
      )}
      {dialog && <StageDialog projectId={dialog.deal.id} stage={dialog.stage} deal={{ details: null, stage: dialog.deal.stage }} initial={dialog.initial} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange(); }} />}
    </>
  );
}
