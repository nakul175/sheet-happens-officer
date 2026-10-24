"use client";
// SHO-US-12.2: the gate dialog. The server enforces the same fields; this only helps fill them in.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { ATHENA_ENTITIES, OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { submissionDeadlineInput, SUBMISSION_TIME_ZONE_LABEL } from "@/lib/submission-deadline";
import { Field, Modal } from "@/components/ui";

export function ConvertDialog({ task, meId, onClose }: { task: { id: string; title: string; dueDate: string | null; assignee: { id: string } }; meId: string; onClose: () => void }) {
  const router = useRouter();
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string }[] }>("/api/deals/pipelines");
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [v, setV] = useState({ organisationId: "", pipelineId: "", name: task.title, leaderId: task.assignee.id, whyPursue: "", dueDate: task.dueDate ?? "", submissionDeadline: "", submissionTime: "", value: "", currency: "INR", opportunityType: "", netFeeRevenueUsd: "", athenaEntity: "", probability: "", newOrg: "", newKind: "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extraOrgs, setExtraOrgs] = useState<{ id: string; name: string }[]>([]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value, ...(k === "submissionDeadline" && !e.target.value ? { submissionTime: "" } : {}) });
  const pipe = pipes.data?.pipelines.find((p) => p.id === (v.pipelineId || pipes.data?.pipelines[0]?.id));
  void meId;

  async function addOrg() {
    const r = await api("POST", "/api/orgs", { name: v.newOrg, kind: v.newKind || null });
    if (r.ok) { setExtraOrgs((o) => [...o, { id: r.data.organisation.id, name: v.newOrg }]); setV({ ...v, organisationId: r.data.organisation.id, newOrg: "", newKind: "" }); setErr(null); }
    else setErr(r.error ?? "Could not add the organisation.");
  }
  async function go(force = false) {
    let submissionDeadline: string | null = null;
    try { if (pipe?.key === "DEAL_BID") submissionDeadline = submissionDeadlineInput(v.submissionDeadline, v.submissionTime); }
    catch (error) { setBusy(false); setErr(error instanceof Error ? error.message : "Choose a valid submission deadline."); return; }
    if (v.netFeeRevenueUsd && (!Number.isFinite(Number(v.netFeeRevenueUsd)) || Number(v.netFeeRevenueUsd) < 0 || Number(v.netFeeRevenueUsd) > 9999999999999.99 || !/^\d+(?:\.\d{1,2})?$/.test(v.netFeeRevenueUsd))) { setErr("Net Fee Revenue must be a nonnegative USD amount with at most two decimal places."); return; }
    if (v.probability && (!Number.isInteger(Number(v.probability)) || Number(v.probability) < 0 || Number(v.probability) > 100)) { setErr("PWin must be a whole percentage from 0 to 100."); return; }
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      organisationId: v.organisationId || undefined, pipelineId: pipe?.id, name: v.name, leaderId: v.leaderId, whyPursue: v.whyPursue,
      dueDate: task.dueDate ? undefined : v.dueDate || undefined, force,
    };
    if (pipe?.key === "DEAL_BID") body.submissionDeadline = submissionDeadline || undefined;
    body.opportunityType = v.opportunityType || null;
    body.netFeeRevenueUsd = v.netFeeRevenueUsd === "" ? null : Number(v.netFeeRevenueUsd);
    body.athenaEntity = v.athenaEntity || null;
    body.probability = v.probability === "" ? null : Number(v.probability);
    if (v.value) { body.value = Number(v.value); body.currency = v.currency; }
    const r = await api("POST", `/api/tasks/${task.id}/convert`, body);
    setBusy(false);
    if (r.ok) { router.push(`/projects/${r.data.deal.id}`); return; }
    setDup(r.data?.needsConfirm === "duplicate");
    setErr(r.error ?? "Could not convert the task.");
  }
  const all = [...(orgs.data?.organisations ?? []), ...extraOrgs.filter((e) => !orgs.data?.organisations.some((o) => o.id === e.id))];
  const ready = v.organisationId && pipe && v.name.trim() && v.whyPursue.trim() && (task.dueDate || v.dueDate) && (pipe.key !== "DEAL_BID" || v.submissionDeadline);
  return (
    <Modal onClose={onClose} label="Convert to deal">
      <h2>Convert to deal</h2>
      <p className="sub">The task moves into the new deal with its subtasks. Undo is available right after.</p>
      <Field label="Organisation (buyer)">{(id) => <select id={id} className="in" value={v.organisationId} onChange={set("organisationId")}><option value="">Choose</option>{all.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}</Field>
      <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
        <Field label="Not listed? New organisation">{(id) => <input id={id} className="in" value={v.newOrg} onChange={set("newOrg")} placeholder="Name" />}</Field>
        <Field label="Kind">{(id) => <input id={id} className="in" value={v.newKind} onChange={set("newKind")} placeholder="e.g. Ministry" />}</Field>
        <button type="button" className="btn ghost sm" disabled={!v.newOrg.trim()} onClick={addOrg}>Add</button>
      </div>
      <Field label="Pipeline">{(id) => <select id={id} className="in" value={pipe?.id ?? ""} onChange={set("pipelineId")}>{pipes.data?.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      <Field label="Deal name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <Field label="Opportunity type">{(id) => <select id={id} className="in" value={v.opportunityType} onChange={set("opportunityType")}><option value="">Unclassified</option>{OPPORTUNITY_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Net Fee Revenue (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={v.netFeeRevenueUsd} onChange={set("netFeeRevenueUsd")} />}</Field>
      <Field label="PWin (%)">{(id) => <input id={id} className="in" type="number" min="0" max="100" step="1" value={v.probability} onChange={set("probability")} />}</Field>
      <Field label="Athena Entity">{(id) => <select id={id} className="in" value={v.athenaEntity} onChange={set("athenaEntity")}><option value="">Not specified</option>{ATHENA_ENTITIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Leader">{(id) => <select id={id} className="in" value={v.leaderId} onChange={set("leaderId")}>{team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      <Field label="Why are we pursuing this?">{(id) => <input id={id} className="in" value={v.whyPursue} onChange={set("whyPursue")} />}</Field>
      {!task.dueDate && <Field label="Due date (becomes the next step)">{(id) => <input id={id} className="in" type="date" value={v.dueDate} onChange={set("dueDate")} />}</Field>}
      {pipe?.key === "DEAL_BID" && <><Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field><Field label={`Submission time (optional) · ${SUBMISSION_TIME_ZONE_LABEL}`}>{(id) => <input id={id} className="in" type="time" value={v.submissionTime} disabled={!v.submissionDeadline} onChange={set("submissionTime")} />}</Field></>}
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Value (optional)">{(id) => <input id={id} className="in" type="number" min="1" value={v.value} onChange={set("value")} />}</Field>
        <Field label="Currency">{(id) => <select id={id} className="in" value={v.currency} onChange={set("currency")}><option>INR</option><option>USD</option><option>EUR</option></select>}</Field>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        {dup && <button className="btn ghost" disabled={busy} onClick={() => go(true)}>Create anyway</button>}
        <button className="btn" disabled={busy || !ready} onClick={() => go()}>Convert to deal</button>
      </div>
    </Modal>
  );
}
