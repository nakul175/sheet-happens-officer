"use client";
// SHO-US-12.2: the gate dialog. The server enforces the same fields; this only helps fill them in.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, Modal } from "@/components/ui";

export function ConvertDialog({ task, meId, onClose }: { task: { id: string; title: string; dueDate: string | null; assignee: { id: string } }; meId: string; onClose: () => void }) {
  const router = useRouter();
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string }[] }>("/api/deals/pipelines");
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [v, setV] = useState({ organisationId: "", pipelineId: "", name: task.title, leaderId: task.assignee.id, whyPursue: "", dueDate: task.dueDate ?? "", submissionDeadline: "", value: "", currency: "INR", newOrg: "", newKind: "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState<string | null>(null);
  const [orgDup, setOrgDup] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [extraOrgs, setExtraOrgs] = useState<{ id: string; name: string }[]>([]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const pipe = pipes.data?.pipelines.find((p) => p.id === (v.pipelineId || pipes.data?.pipelines[0]?.id));
  void meId;

  async function addOrg(force = false) {
    const r = await api("POST", "/api/orgs", { name: v.newOrg, kind: v.newKind || null, force });
    if (r.ok) { setOrgDup(null); setExtraOrgs((o) => [...o, { id: r.data.organisation.id, name: v.newOrg }]); setV({ ...v, organisationId: r.data.organisation.id, newOrg: "", newKind: "" }); setErr(null); }
    else { setErr(r.error ?? "Could not add the organisation."); setOrgDup(r.data?.needsConfirm === "duplicate" ? { id: r.data.existingId, name: r.data.existingName } : null); }
  }
  async function go(force = false) {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      organisationId: v.organisationId || undefined, pipelineId: pipe?.id, name: v.name, leaderId: v.leaderId, whyPursue: v.whyPursue,
      dueDate: task.dueDate ? undefined : v.dueDate || undefined, force,
    };
    if (pipe?.key === "DEAL_BID") body.submissionDeadline = v.submissionDeadline || undefined;
    if (v.value) { body.value = Number(v.value); body.currency = v.currency; }
    const r = await api("POST", `/api/tasks/${task.id}/convert`, body);
    setBusy(false);
    if (r.ok) { router.push(`/projects/${r.data.deal.id}`); return; }
    setDup(r.data?.needsConfirm === "duplicate" ? r.data.existingId ?? "" : null);
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
        <button type="button" className="btn ghost sm" disabled={!v.newOrg.trim()} onClick={() => addOrg()}>Add</button>
      </div>
      {orgDup && <div className="actions"><button className="btn ghost" onClick={() => { setExtraOrgs((o) => [...o, orgDup]); setV({ ...v, organisationId: orgDup.id, newOrg: "" }); setOrgDup(null); setErr(null); }}>Use this one</button><button className="btn ghost" onClick={() => addOrg(true)}>Create anyway</button></div>}
      <Field label="Pipeline">{(id) => <select id={id} className="in" value={pipe?.id ?? ""} onChange={set("pipelineId")}>{pipes.data?.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      <Field label="Deal name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <Field label="Leader">{(id) => <select id={id} className="in" value={v.leaderId} onChange={set("leaderId")}>{team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      <Field label="Why are we pursuing this?">{(id) => <input id={id} className="in" value={v.whyPursue} onChange={set("whyPursue")} />}</Field>
      {!task.dueDate && <Field label="Due date (becomes the next step)">{(id) => <input id={id} className="in" type="date" value={v.dueDate} onChange={set("dueDate")} />}</Field>}
      {pipe?.key === "DEAL_BID" && <Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field>}
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Value (optional)">{(id) => <input id={id} className="in" type="number" min="1" value={v.value} onChange={set("value")} />}</Field>
        <Field label="Currency">{(id) => <select id={id} className="in" value={v.currency} onChange={set("currency")}><option>INR</option><option>USD</option><option>EUR</option></select>}</Field>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        {dup && <button className="btn ghost" onClick={() => router.push(`/projects/${dup}`)}>Use this one</button>}
        {dup !== null && <button className="btn ghost" disabled={busy} onClick={() => go(true)}>Create anyway</button>}
        <button className="btn" disabled={busy || !ready} onClick={() => go()}>Convert to deal</button>
      </div>
    </Modal>
  );
}
