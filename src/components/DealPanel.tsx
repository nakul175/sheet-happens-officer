"use client";
import Link from "next/link";
import { ATHENA_ENTITIES, OPPORTUNITY_TYPES, type AthenaEntity, type OpportunityType } from "@/lib/deal-classification";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, dueLabel, isOverdue, useGet } from "@/components/api";
import { Field, Modal } from "@/components/ui";

export type Stage = { id: string; name: string; category: string; needsReason: boolean; requiredFields: string[] };
export type DealBlock = {
  pipeline: { id: string; key: string; name: string; stages: Stage[] } | null;
  stage: { id: string; name: string; category: string } | null;
  stageReason: string | null;
  details: { whyPursue: string | null; need: string | null; serviceLine: string | null; value: number | null; currency: string | null; probability: number | null; expectedClose: string | null; introducedBy: string | null; submissionDeadline: string | null; opportunityType?: OpportunityType | null; netFeeRevenueUsd?: number | null; athenaEntity?: AthenaEntity | null } | null;
  parties: { id: string; role: string; organisation: { id: string; name: string } }[];
  organisation: { id: string; name: string } | null;
  nextStep: { id: string; title: string; dueDate: string | null; assignee?: { id: string; name: string } | null } | null;
  needsNextStep: boolean; stalled: boolean;
};

export const money = (v: number | null, c: string | null) => (v === null ? "No value yet" : `${c ?? ""} ${v.toLocaleString("en-IN")}`.trim());
const LABELS: Record<string, string> = { value: "Value", currency: "Currency", expectedClose: "Expected close", submissionDeadline: "Submission deadline", probability: "PWin (%)", need: "Need", serviceLine: "Service line", introducedBy: "Introduced by" };

export type Blocked = { openTasks: number; tasks: { id: string; title: string; assignee?: string | null }[] };

/** Won and Lost are the stages a deal cannot enter while a task is open (SHO-US-10.3 AC6). */
export const stageClosesDeal = (category: string) => category === "DONE" || category === "LOST";

/** The alert payload: a positive count, and at most the first 20 tasks the server named. */
export function closingAlert(data: { openTasks?: number; tasks?: Blocked["tasks"] } | null | undefined): Blocked | null {
  const openTasks = data?.openTasks ?? 0;
  if (openTasks <= 0) return null;
  return { openTasks, tasks: (data?.tasks ?? []).slice(0, 20) };
}

/** One open task stays singular ("1 open task"); every other count is plural. */
export function openTaskAlertText(openTasks: number) {
  return `Close or move these ${openTasks} open task${openTasks === 1 ? "" : "s"} first:`;
}

/** Past the 20 titles the dialog lists, say how many are left. */
export function moreOpenTasks(openTasks: number, shown: number) {
  const n = openTasks - shown;
  return n > 0 ? `and ${n} more` : null;
}

export const LOAD_OPEN_TASKS = "Could not load the open tasks.";

export type OpenTaskFeed = {
  status: "loading" | "ready" | "error" | "partial";
  openCount: number;
  tasks: { id: string; title: string; assignee?: string | null }[];
};

type FeedTask = { id: string; title: string; completedAt: string | null; assignee?: { name: string } | null };
type FeedSection = { isDone: boolean; total: number; nextCursor: string | null; tasks: FeedTask[] };

/** Open tasks from the list the deal page already loaded. `partial` means that list is filtered or cut short.
 * `refusalCount` is the server's Won/Lost count, which includes subtasks. It wins over the top-level total. */
export function openTaskFeed(sections: FeedSection[], summaryOpen: number | undefined, filtered: boolean, refusalCount?: number): OpenTaskFeed {
  const tasks = sections.flatMap((s) => s.tasks.filter((t) => !t.completedAt)).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee?.name ?? null }));
  const openCount = refusalCount ?? summaryOpen ?? tasks.length;
  const partial = filtered || sections.some((s) => !s.isDone && (s.nextCursor != null || s.total > s.tasks.length));
  return { status: partial ? "partial" : "ready", openCount, tasks };
}

export type ClosingPlan =
  | { kind: "ignore" }
  | { kind: "wait" }
  | { kind: "fetch" }
  | { kind: "open"; blocked: Blocked | null; loadError: string | null };

/** What to do with a Won or Lost click. A second click while the first is still waiting is ignored. */
export function planClosing(o: { pending: boolean; status: OpenTaskFeed["status"]; openCount: number; tasks: OpenTaskFeed["tasks"] }): ClosingPlan {
  if (o.pending) return { kind: "ignore" };
  if (o.status === "loading") return { kind: "wait" };
  if (o.status === "error") return { kind: "open", blocked: null, loadError: LOAD_OPEN_TASKS };
  if (o.status === "partial") return { kind: "fetch" };
  return { kind: "open", blocked: closingAlert({ openTasks: o.openCount, tasks: o.tasks }), loadError: null };
}

export type StageInitial = { err?: string | null; blocked?: Blocked | null; need?: string[]; loadError?: string | null };
export function StageDialog({ projectId, stage, deal, initial, onClose, onDone }: { projectId: string; stage: Stage; deal: Pick<DealBlock, "details">; initial?: StageInitial; onClose: () => void; onDone: () => void }) {
  const alertId = useId();
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [need, setNeed] = useState<string[]>(initial?.need ?? []);
  const [err, setErr] = useState<string | null>(initial?.err ?? null);
  const [loadError, setLoadError] = useState<string | null>(initial?.loadError ?? null);
  const [blocked, setBlocked] = useState<Blocked | null>(initial?.blocked ?? null);
  const [busy, setBusy] = useState(false);
  const d = deal.details;
  const missing = stage.requiredFields.filter((k) => {
    const cur = (d as Record<string, unknown> | null)?.[k];
    return cur === null || cur === undefined || cur === "";
  });
  const ask = Array.from(new Set([...missing, ...need]));
  async function go() {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { stageId: stage.id };
    if (stage.needsReason) body.reason = reason;
    const f: Record<string, unknown> = {};
    for (const k of ask) {
      const raw = fields[k]; if (raw === undefined || raw === "") continue;
      f[k] = k === "value" || k === "probability" ? Number(raw) : raw;
    }
    if (Object.keys(f).length) body.fields = f;
    const r = await api("POST", `/api/projects/${projectId}/stage`, body);
    setBusy(false);
    if (r.ok) { onDone(); return; }
    const next = closingAlert(r.data);
    if (next) setBlocked(next);
    if (r.data?.needsFields) setNeed(r.data.needsFields);
    setLoadError(null);
    setErr(r.error ?? "Could not move the deal.");
  }
  const problem = !blocked && (loadError || err);
  const more = blocked ? moreOpenTasks(blocked.openTasks, blocked.tasks.length) : null;
  return (
    <Modal onClose={onClose} label={`Move to ${stage.name}`} describedBy={blocked || problem ? alertId : undefined}>
      <h2>Move to {stage.name}</h2>
      {stage.needsReason && <Field label="Reason (required)">{(id) => <textarea id={id} className="in" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
      {ask.map((k) => (
        <Field key={k} label={`${LABELS[k] ?? k} (required)`}>
          {(id) => k === "currency"
            ? <select id={id} className="in" value={fields[k] ?? ""} onChange={(e) => setFields({ ...fields, [k]: e.target.value })}><option value="">Choose</option><option>INR</option><option>USD</option><option>EUR</option></select>
            : <input id={id} className="in" type={k === "value" || k === "probability" ? "number" : k.includes("Close") || k.includes("Deadline") ? "date" : "text"} value={fields[k] ?? ""} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />}
        </Field>
      ))}
      {(blocked || problem) && (
        <div id={alertId} className="err" role="alert" tabIndex={-1} data-autofocus>
          {blocked ? (
            <>
              {openTaskAlertText(blocked.openTasks)}
              <ul style={{ margin: "6px 0 0 18px" }}>
                {blocked.tasks.map((t) => <li key={t.id}><Link href={`/projects/${projectId}?task=${t.id}`}>{t.title}</Link>{t.assignee ? ` · ${t.assignee}` : ""}</li>)}
              </ul>
              {more && <p>{more}</p>}
            </>
          ) : problem}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || (stage.needsReason && !reason.trim())} onClick={go}>Move deal</button>
      </div>
    </Modal>
  );
}

function DetailsDialog({ projectId, deal, onClose, onDone }: { projectId: string; deal: DealBlock; onClose: () => void; onDone: () => void }) {
  const formId = useId();
  const d = deal.details!;
  const [v, setV] = useState<Record<string, string>>({
    whyPursue: d.whyPursue ?? "", need: d.need ?? "", serviceLine: d.serviceLine ?? "", value: d.value === null ? "" : String(d.value), currency: d.currency ?? "",
    opportunityType: d.opportunityType ?? "", netFeeRevenueUsd: d.netFeeRevenueUsd == null ? "" : String(d.netFeeRevenueUsd), athenaEntity: d.athenaEntity ?? "",
    probability: d.probability === null ? "" : String(d.probability), expectedClose: d.expectedClose ?? "", introducedBy: d.introducedBy ?? "", submissionDeadline: d.submissionDeadline ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      whyPursue: v.whyPursue, need: v.need || null, serviceLine: v.serviceLine || null, introducedBy: v.introducedBy || null,
      value: v.value === "" ? null : Number(v.value), currency: v.currency || null, probability: v.probability === "" ? null : Number(v.probability),
      expectedClose: v.expectedClose || null, submissionDeadline: v.submissionDeadline || null,
      opportunityType: v.opportunityType || null, netFeeRevenueUsd: v.netFeeRevenueUsd === "" ? null : Number(v.netFeeRevenueUsd), athenaEntity: v.athenaEntity || null,
    };
    const r = await api("PATCH", `/api/projects/${projectId}/deal`, body);
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.error ?? "Could not save.");
  }
  return (
    <Modal onClose={onClose} label="Deal details">
      <form id={formId} onSubmit={save}>
      <h2>Deal details</h2>
      <Field label="Opportunity type">{(id) => <select id={id} className="in" value={v.opportunityType} onChange={set("opportunityType")}><option value="">Unclassified</option>{OPPORTUNITY_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Why we are pursuing this">{(id) => <input id={id} className="in" value={v.whyPursue} onChange={set("whyPursue")} />}</Field>
      <Field label="Need">{(id) => <textarea id={id} className="in" value={v.need} onChange={set("need")} />}</Field>
      <Field label="Service line">{(id) => <input id={id} className="in" value={v.serviceLine} onChange={set("serviceLine")} />}</Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Value (blank = unknown)">{(id) => <input id={id} className="in" type="number" min="0" value={v.value} onChange={set("value")} />}</Field>
        <Field label="Currency">{(id) => <select id={id} className="in" value={v.currency} onChange={set("currency")}><option value="">—</option><option>INR</option><option>USD</option><option>EUR</option></select>}</Field>
        <Field label="PWin (%)">{(id) => <input id={id} className="in" type="number" min="0" max="100" value={v.probability} onChange={set("probability")} />}</Field>
      </div>
      <Field label="Net Fee Revenue (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={v.netFeeRevenueUsd} onChange={set("netFeeRevenueUsd")} />}</Field>
      <Field label="Athena Entity">{(id) => <select id={id} className="in" value={v.athenaEntity} onChange={set("athenaEntity")}><option value="">Not specified</option>{ATHENA_ENTITIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Expected close">{(id) => <input id={id} className="in" type="date" value={v.expectedClose} onChange={set("expectedClose")} />}</Field>
      {deal.pipeline?.key === "DEAL_BID" && <Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field>}
      <Field label="Introduced by">{(id) => <input id={id} className="in" value={v.introducedBy} onChange={set("introducedBy")} />}</Field>
      {err && <div className="err" role="alert">{err}</div>}
      </form>
      <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" form={formId} disabled={busy}>Save</button></div>
    </Modal>
  );
}

/** Deal names use the existing project-management endpoint and permission. */
function RenameDeal({ projectId, name, onClose, onDone }: { projectId: string; name: string; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true); setErr(null);
    const r = await api("PATCH", `/api/projects/${projectId}`, { name: value.trim() });
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.error ?? "Could not rename the deal.");
  }
  return <Modal small onClose={onClose} label="Rename opportunity">
    <form onSubmit={save}>
      <h2>Rename opportunity</h2>
      <Field label="Opportunity name">{(id) => <input id={id} className="in" required maxLength={200} value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !value.trim()}>Save name</button></div>
    </form>
  </Modal>;
}

const PARTY_LABEL: Record<string, string> = { BUYER: "Buyer", FUNDER: "Funder", IMPLEMENTING_OFFICE: "Implementing office", PARTNER: "Partner", OTHER: "Other" };
function Parties({ projectId, deal, canWrite, onChange }: { projectId: string; deal: DealBlock; canWrite: boolean; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [org, setOrg] = useState("");
  const [role, setRole] = useState("FUNDER");
  const [err, setErr] = useState<string | null>(null);
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>(adding ? "/api/orgs" : null);
  async function add() {
    const r = await api("POST", `/api/projects/${projectId}/parties`, { organisationId: org, role });
    if (r.ok) { setAdding(false); setOrg(""); onChange(); } else setErr(r.error ?? "Could not add.");
  }
  async function remove(id: string) { const r = await api("DELETE", `/api/projects/${projectId}/parties/${id}`); if (r.ok) onChange(); else setErr(r.error ?? "Could not remove."); }
  return (
    <div style={{ marginTop: 10, fontSize: 14 }}>
      <b>Organisations:</b>{" "}
      {deal.parties.map((p) => (
        <span key={p.id} className="chip" style={{ marginRight: 4, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {PARTY_LABEL[p.role]}: <Link href={`/accounts/${p.organisation.id}`}>{p.organisation.name}</Link>
          {canWrite && p.role !== "BUYER" && <button className="link" aria-label={`Remove ${p.organisation.name}`} onClick={() => remove(p.id)} style={{ marginLeft: 4 }}>×</button>}
        </span>
      ))}
      {canWrite && !adding && <button className="btn ghost sm" onClick={() => setAdding(true)}>+ Add organisation</button>}
      {adding && (
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <select className="in" aria-label="Organisation" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">Choose</option>{orgs.data?.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <select className="in" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(PARTY_LABEL).filter(([k]) => k !== "BUYER").map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn sm" disabled={!org} onClick={add}>Add</button><button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
        </span>
      )}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

function DealNotes({ projectId, orgId }: { projectId: string; orgId: string | null }) {
  const { data } = useGet<{ notes: { id: string; kind: string; date: string; text: string; author: { name: string }; contacts: { name: string }[] }[] }>(`/api/projects/${projectId}/notes`);
  const notes = data?.notes ?? [];
  return (
    <div style={{ marginTop: 10, fontSize: 14 }}>
      <b>Notes</b> {orgId && <Link href={`/accounts/${orgId}`}>Add a note on the organisation page</Link>}
      {notes.length === 0 && <div style={{ color: "var(--muted)" }}>No notes linked to this deal.</div>}
      {notes.slice(0, 5).map((n) => (
        <div key={n.id} style={{ marginTop: 4 }}><span className="chip">{n.kind.charAt(0) + n.kind.slice(1).toLowerCase()}</span> {dueLabel(n.date)} · {n.author.name}{n.contacts.length ? ` · with ${n.contacts.map((c) => c.name).join(", ")}` : ""}<div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div></div>
      ))}
    </div>
  );
}

export function DealPanel({ projectId, projectName, deal, canWrite, canManage = false, onChange, feed }: { projectId: string; projectName?: string; deal: DealBlock; canWrite: boolean; canManage?: boolean; onChange: () => void; feed: OpenTaskFeed }) {
  const [pick, setPick] = useState<null | { stage: Stage; blocked: Blocked | null; loadError: string | null }>(null);
  const [armed, setArmed] = useState<Stage | null>(null);
  const [edit, setEdit] = useState(false);
  const [rename, setRename] = useState(false);
  const pending = useRef(false);
  const ticket = useRef(0); // a closed or replaced click ignores a list that arrives later
  const d = deal.details;
  const cur = deal.stage?.id;
  const close = useCallback(() => { ticket.current += 1; pending.current = false; setArmed(null); setPick(null); }, []);
  // APL-2691: the alert is part of the dialog's first paint, from the task list already on the page.
  // A second click while that list is still loading does nothing. A failed load is said in the dialog.
  function openFrom(s: Stage, source: OpenTaskFeed) {
    const plan = planClosing({ pending: false, status: source.status, openCount: source.openCount, tasks: source.tasks });
    if (plan.kind !== "open") return;
    setPick({ stage: s, blocked: plan.blocked, loadError: plan.loadError });
    setArmed(null);
  }
  async function loadFull(s: Stage, mine: number) {
    const r = await api<{ sections?: FeedSection[]; summary?: { open: number; openTasks?: number } }>("GET", `/api/projects/${projectId}/tasks?limit=100`);
    if (mine !== ticket.current) return;
    if (!r.ok) setPick({ stage: s, blocked: null, loadError: r.error ?? LOAD_OPEN_TASKS });
    else {
      const next = openTaskFeed(r.data.sections ?? [], r.data.summary?.open, false, r.data.summary?.openTasks);
      setPick({ stage: s, blocked: closingAlert({ openTasks: next.openCount, tasks: next.tasks }), loadError: null });
    }
    setArmed(null);
  }
  function choose(s: Stage) {
    if (!stageClosesDeal(s.category)) {
      if (pending.current) return; // the list for a Won or Lost click is still loading
      setPick({ stage: s, blocked: null, loadError: null });
      return;
    }
    const plan = planClosing({ pending: pending.current, status: feed.status, openCount: feed.openCount, tasks: feed.tasks });
    if (plan.kind === "ignore") return;
    pending.current = true;
    if (plan.kind === "wait") { setArmed(s); return; }
    if (plan.kind === "fetch") { void loadFull(s, ticket.current); return; }
    openFrom(s, feed);
  }
  // The click landed before the page's list arrived. Opening here keeps that click to one render once the list is known.
  if (armed && feed.status !== "loading") openFrom(armed, feed);
  useEffect(() => {
    if (!armed || feed.status !== "partial") return;
    const stage = armed;
    const mine = ticket.current;
    void loadFull(stage, mine);
    return () => { ticket.current += 1; };
    // loadFull awaits the existing task list, then opens the dialog. The state update is not synchronous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, feed.status]);
  return (
    <section className="card" aria-label="Deal" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label="Stage">
        {deal.pipeline?.stages.map((s) => (
          <button key={s.id} className={`btn sm${s.id === cur ? "" : " ghost"}`} aria-current={s.id === cur ? "step" : undefined} disabled={!canWrite || s.id === cur} onClick={() => void choose(s)}>{s.name}</button>
        ))}
      </div>
      <div className="meta" style={{ justifyContent: "flex-start", marginTop: 10 }}>
        <span className="chip">{deal.pipeline?.name}</span>
        {deal.organisation && <Link href={`/accounts/${deal.organisation.id}`}>{deal.organisation.name}</Link>}
        <span>{money(d?.value ?? null, d?.currency ?? null)}</span>
        <span>Opportunity type: {OPPORTUNITY_TYPES.find(o => o.value === d?.opportunityType)?.label ?? "Unclassified"}</span>
        {d?.netFeeRevenueUsd != null && <span>Net Fee Revenue: {money(d.netFeeRevenueUsd, "USD")}</span>}
        {d?.athenaEntity && <span>Athena Entity: {ATHENA_ENTITIES.find(o => o.value === d.athenaEntity)?.label ?? d.athenaEntity}</span>}
        {d?.probability !== null && d?.probability !== undefined && <span>PWin: {d.probability}%</span>}
        {d?.expectedClose && <span>Close {dueLabel(d.expectedClose)}</span>}
        {d?.submissionDeadline && <span className={isOverdue(d.submissionDeadline) ? "over" : ""}>Submit by {dueLabel(d.submissionDeadline)}</span>}
        {deal.stalled && <span className="chip gold">Stalled · no activity for 30 days</span>}
        {deal.stageReason && <span>Reason: {deal.stageReason}</span>}
        {canWrite && <button className="btn ghost sm" onClick={() => setEdit(true)}>Edit details</button>}
        {canManage && projectName !== undefined && <button className="btn ghost sm" onClick={() => setRename(true)}>Rename opportunity</button>}
        {canManage && <Link className="btn ghost sm" href={`/projects/${projectId}/members`}>Change leader</Link>}
      </div>
      {d?.whyPursue && <p style={{ margin: "8px 0 0", fontSize: 14 }}><b>Why:</b> {d.whyPursue}</p>}
      <p style={{ margin: "8px 0 0", fontSize: 14 }}>
        {deal.nextStep
          ? <><b>Next step:</b> {deal.nextStep.title} · <span className={isOverdue(deal.nextStep.dueDate) ? "over" : ""}>{dueLabel(deal.nextStep.dueDate)}</span></>
          : deal.needsNextStep ? <span className="chip red">No next step. Add a dated task.</span> : <span style={{ color: "var(--muted)" }}>No next step needed in this stage.</span>}
      </p>
      <DealNotes projectId={projectId} orgId={deal.organisation?.id ?? null} />
      <Parties projectId={projectId} deal={deal} canWrite={canWrite} onChange={onChange} />
      {pick && deal && <StageDialog projectId={projectId} stage={pick.stage} deal={deal} initial={{ blocked: pick.blocked, loadError: pick.loadError }} onClose={close} onDone={() => { close(); onChange(); }} />}
      {rename && canManage && projectName !== undefined && <RenameDeal projectId={projectId} name={projectName} onClose={() => setRename(false)} onDone={() => { setRename(false); onChange(); }} />}
      {edit && d && <DetailsDialog projectId={projectId} deal={deal} onClose={() => setEdit(false)} onDone={() => { setEdit(false); onChange(); }} />}
    </section>
  );
}
