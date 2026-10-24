"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, todayIST, useGet } from "@/components/api";
import { ATHENA_ENTITIES, OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { submissionDeadlineInput, SUBMISSION_TIME_ZONE_LABEL } from "@/lib/submission-deadline";
import { BuyerAccountPicker } from "@/components/BuyerAccountPicker";
import { Field } from "@/components/ui";
import { Page, useMe } from "../../Shell";

function Form() {
  const me = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [buyer, setBuyer] = useState<{ id: string; name: string } | null>(sp.get("org") ? { id: sp.get("org")!, name: "Selected Account" } : null);
  const [creatingBuyer, setCreatingBuyer] = useState(false);
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string }[] }>("/api/deals/pipelines");
  const [v, setV] = useState({ name: "", organisationId: sp.get("org") ?? "", pipelineId: "", leaderId: me.id, whyPursue: "", step: "", due: todayIST(), submissionDeadline: "", submissionTime: "", value: "", currency: "INR", opportunityType: "", netFeeRevenueUsd: "", athenaEntity: "", probability: "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value, ...(k === "submissionDeadline" && !e.target.value ? { submissionTime: "" } : {}) });
  const pipeline = pipes.data?.pipelines.find((p) => p.id === (v.pipelineId || pipes.data?.pipelines[0]?.id));
  async function submit(e: React.FormEvent, force = false) {
    e.preventDefault(); if (creatingBuyer || busy) return; setBusy(true); setErr(null);
    let submissionDeadline: string | null = null;
    try { if (pipeline?.key === "DEAL_BID") submissionDeadline = submissionDeadlineInput(v.submissionDeadline, v.submissionTime); }
    catch (error) { setBusy(false); setErr(error instanceof Error ? error.message : "Choose a valid submission deadline."); return; }
    const body: Record<string, unknown> = {
      name: v.name, organisationId: v.organisationId, pipelineId: pipeline?.id, leaderId: v.leaderId, whyPursue: v.whyPursue,
      nextStep: { title: v.step, dueDate: v.due }, force,
    };
    if (pipeline?.key === "DEAL_BID") body.submissionDeadline = submissionDeadline;
    body.opportunityType = v.opportunityType || null;
    body.netFeeRevenueUsd = v.netFeeRevenueUsd === "" ? null : Number(v.netFeeRevenueUsd);
    body.athenaEntity = v.athenaEntity || null;
    body.probability = v.probability === "" ? null : Number(v.probability);
    if (v.value) { body.value = Number(v.value); body.currency = v.currency; }
    const r = await api("POST", "/api/deals", body);
    setBusy(false);
    if (r.ok) { router.push(`/projects/${r.data.deal.id}`); return; }
    setDup(r.data?.needsConfirm === "duplicate");
    setErr(r.error ?? "Could not create the deal.");
  }
  return (
    <form className="card" style={{ maxWidth: 600 }} onSubmit={(e) => submit(e)}>
      <Field label="Deal name">{(id) => <input id={id} className="in" required maxLength={200} value={v.name} onChange={set("name")} />}</Field>
      <BuyerAccountPicker value={buyer} disabled={busy || creatingBuyer} onBusyChange={setCreatingBuyer} onChange={account => { setBuyer(account); setV(current => ({ ...current, organisationId: account.id })); }} />
      <Field label="Pipeline">{(id) => <select id={id} className="in" value={pipeline?.id ?? ""} onChange={set("pipelineId")}>{pipes.data?.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      {pipeline?.key === "DEAL_BID" && <><Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" required value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field><Field label={`Submission time (optional) · ${SUBMISSION_TIME_ZONE_LABEL}`}>{(id) => <input id={id} className="in" type="time" value={v.submissionTime} disabled={!v.submissionDeadline} onChange={set("submissionTime")} />}</Field></>}
      <Field label="Opportunity type">{(id) => <select id={id} className="in" value={v.opportunityType} onChange={set("opportunityType")}><option value="">Unclassified</option>{OPPORTUNITY_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Net Fee Revenue (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={v.netFeeRevenueUsd} onChange={set("netFeeRevenueUsd")} />}</Field>
      <Field label="PWin (%)">{(id) => <input id={id} className="in" type="number" min="0" max="100" step="1" value={v.probability} onChange={set("probability")} />}</Field>
      <Field label="Athena Entity">{(id) => <select id={id} className="in" value={v.athenaEntity} onChange={set("athenaEntity")}><option value="">Not specified</option>{ATHENA_ENTITIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Leader">{(id) => <select id={id} className="in" value={v.leaderId} onChange={set("leaderId")}>{team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.id ? " (you)" : ""}</option>)}</select>}</Field>
      <Field label="Why are we pursuing this?">{(id) => <input id={id} className="in" required maxLength={1000} value={v.whyPursue} onChange={set("whyPursue")} />}</Field>
      <Field label="First next step">{(id) => <input id={id} className="in" required value={v.step} onChange={set("step")} />}</Field>
      <Field label="Next step due">{(id) => <input id={id} className="in" type="date" required value={v.due} onChange={set("due")} />}</Field>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Value (optional)">{(id) => <input id={id} className="in" type="number" min="1" value={v.value} onChange={set("value")} />}</Field>
        <Field label="Currency">{(id) => <select id={id} className="in" value={v.currency} onChange={set("currency")}><option>INR</option><option>USD</option><option>EUR</option></select>}</Field>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={busy || creatingBuyer}>Create deal</button>
        {dup && <button type="button" className="btn ghost" disabled={busy || creatingBuyer} onClick={(e) => submit(e, true)}>Create anyway</button>}
      </div>
    </form>
  );
}
export default function NewDeal() {
  return <Page title="New deal" sub={<Link href="/deals">← Deals</Link>}><Suspense><Form /></Suspense></Page>;
}
