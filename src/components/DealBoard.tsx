"use client";
// SHO-US-10.5 / 12.6: the one grouped view of deals. Columns are a pipeline's stages (Paused, Done and Lost share the last
// column). Desktop: columns scroll sideways inside the board. Phone: the same groups as a vertical list.
import { compareSubmissionDeadlines, submissionDeadlineLabel, submissionDeadlinePassed } from "@/lib/submission-deadline";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, dueLabel, isOverdue } from "@/components/api";
import { Blocked, StageDialog, money, type Stage, type StageInitial } from "@/components/DealPanel";
import { Menu, Modal } from "@/components/ui";

export type BoardDeal = {
  id: string; name: string; archived: boolean; pipeline: { id: string; key: string; name: string } | null; stage: { id: string; name: string; category: string } | null;
  organisation: { id: string; name: string } | null; leader: { id: string; name: string } | null; value: number | null; currency: string | null;
  submissionDeadline: string | null; submissionDeadlineAt?: string | null; submissionDeadlineZone?: string | null; submissionDeadlineTime?: string | null; nextStep: { title: string; dueDate: string | null } | null; needsNextStep: boolean; stalled: boolean;
};
export type BoardStage = Stage & { id: string; name: string; category: string };
type Col = { key: string; title: string; stages: BoardStage[]; deals: BoardDeal[] };

const isLastGroup = (c: string) => c === "PAUSED" || c === "DONE" || c === "LOST";

export function columnsFor(stages: BoardStage[], deals: BoardDeal[], bid: boolean): Col[] {
  const cols: Col[] = stages.filter((s) => !isLastGroup(s.category)).map((s) => ({ key: s.id, title: s.name, stages: [s], deals: [] }));
  const tail = stages.filter((s) => isLastGroup(s.category));
  if (tail.length) cols.push({ key: "tail", title: tail.map((s) => s.name).join(" / "), stages: tail, deals: [] });
  for (const d of deals) {
    if (d.archived || !d.stage) continue;
    const c = cols.find((c) => c.stages.some((s) => s.id === d.stage!.id));
    c?.deals.push(d);
  }
  if (bid) for (const c of cols) c.deals.sort((a, b) => compareSubmissionDeadlines(a, b));
  return cols;
}

export function totals(deals: BoardDeal[]) {
  const sums = new Map<string, number>();
  let unknown = 0;
  for (const d of deals) {
    if (d.value === null || !d.currency) unknown++;
    else sums.set(d.currency, (sums.get(d.currency) ?? 0) + d.value);
  }
  return { sums: [...sums].map(([c, v]) => `${c} ${v.toLocaleString("en-IN")}`), unknown };
}

function Card({ d, stages, onMove, bid }: { d: BoardDeal; stages: BoardStage[]; onMove: (d: BoardDeal, s: BoardStage) => void; bid: boolean }) {
  return (
    <div className="dcard" draggable onDragStart={(e) => e.dataTransfer.setData("text/deal", d.id)}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
        <Link href={`/projects/${d.id}`}><b>{d.name}</b></Link>
        <Menu label={`Move ${d.name}`}>{(close) => (
          <>
            <div className="mhead">Move to…</div>
            {stages.filter((s) => s.id !== d.stage?.id).map((s) => <button key={s.id} role="menuitem" onClick={() => { close(); onMove(d, s); }}>{s.name}</button>)}
          </>
        )}</Menu>
      </div>
      {d.organisation && <div className="sub2">{d.organisation.name}</div>}
      <div className="sub2">{money(d.value, d.currency)}{d.leader ? ` · ${d.leader.name}` : ""}</div>
      {bid && d.submissionDeadline && <div className={`sub2${submissionDeadlinePassed(d) ? " over" : ""}`}>{submissionDeadlinePassed(d) ? "Deadline passed " : "Submit by "}{submissionDeadlineLabel(d)}</div>}
      <div className="sub2">
        {d.nextStep ? <>Next: {d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">Needs a next step</span> : null}
        {d.stalled && <span className="chip gold" style={{ marginLeft: 4 }}>Stalled</span>}
      </div>
    </div>
  );
}

export function DealBoard({ deals, stages, bid, canMove = true, onChange }: { deals: BoardDeal[]; stages: BoardStage[]; bid: boolean; canMove?: boolean; onChange: () => void }) {
  const cols = useMemo(() => columnsFor(stages, deals, bid), [stages, deals, bid]);
  const [dialog, setDialog] = useState<null | { deal: BoardDeal; stage: BoardStage; initial?: StageInitial }>(null);
  const [which, setWhich] = useState<null | { deal: BoardDeal; stages: BoardStage[] }>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function move(d: BoardDeal, s: BoardStage) {
    setErr(null);
    if (d.stage?.id === s.id) return;
    if (s.needsReason) { setDialog({ deal: d, stage: s }); return; }
    const r = await api("POST", `/api/projects/${d.id}/stage`, { stageId: s.id });
    if (r.ok) { onChange(); return; }
    const blocked: Blocked | null = r.data?.openTasks ? { openTasks: r.data.openTasks, tasks: r.data.tasks ?? [] } : null;
    if (blocked || r.data?.needsFields) setDialog({ deal: d, stage: s, initial: { err: r.error, blocked, need: r.data?.needsFields } });
    else setErr(r.error ?? "Could not move the deal.");
  }
  function drop(c: Col, id: string) {
    const d = deals.find((x) => x.id === id);
    if (!d || !canMove) return;
    if (c.stages.length === 1) void move(d, c.stages[0]);
    else setWhich({ deal: d, stages: c.stages.filter((s) => s.id !== d.stage?.id) });
  }
  return (
    <>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="dboard">
        {cols.map((c) => {
          const t = totals(c.deals);
          return (
            <section key={c.key} className={`dcol${over === c.key ? " over" : ""}`} aria-label={c.title}
              onDragOver={(e) => { if (canMove) { e.preventDefault(); setOver(c.key); } }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/deal"); if (id) drop(c, id); }}>
              <header>
                <b>{c.title}</b> <span className="chip grey">{c.deals.length}</span>
                <div className="sub2">{t.sums.length ? t.sums.join(" · ") : "No values"}{t.unknown > 0 ? ` · ${t.unknown} without value` : ""}</div>
              </header>
              {c.deals.map((d) => <Card key={d.id} d={d} stages={stages} onMove={move} bid={bid} />)}
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
      {dialog && <StageDialog projectId={dialog.deal.id} stage={dialog.stage} deal={{ details: null }} initial={dialog.initial} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange(); }} />}
    </>
  );
}
