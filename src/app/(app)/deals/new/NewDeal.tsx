"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, todayIST, useGet } from "@/components/api";
import { ATHENA_ENTITIES, OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { Field } from "@/components/ui";
import { PeopleSelect } from "@/components/PeopleSelect";
import { Page, useMe } from "../../Shell";

import "./new-deal-approved.css";
function Form() {
  const me = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const team = useGet<{ people: { id: string; name: string; email?: string }[] }>("/api/team");
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string }[] }>("/api/deals/pipelines");
  const initialOrgId = sp.get("org") ?? "";
  const [v, setV] = useState({ name: "", organisationId: initialOrgId, buyerName: "", pipelineId: "", leaderId: me.id, whyPursue: "", step: "", due: todayIST(), submissionDeadline: "", value: "", currency: "INR", opportunityType: "", netFeeRevenueUsd: "", athenaEntity: "", probability: "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const pipeline = pipes.data?.pipelines.find((p) => p.id === (v.pipelineId || pipes.data?.pipelines[0]?.id));
  const organisations = orgs.data?.organisations ?? [];
  const selectedBuyer = organisations.find((o) => o.id === v.organisationId);
  const buyerName = (v.buyerName || selectedBuyer?.name || "").trim();
  function setBuyer(e: React.ChangeEvent<HTMLInputElement>) {
    const name = e.target.value;
    const match = organisations.find((o) => o.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
    setV({ ...v, buyerName: name, organisationId: match?.id ?? "" });
    setDup(false);
  }
  async function submit(e: React.FormEvent, force = false, createBuyer = false) {
    if (createBuyer && !(e.currentTarget as HTMLButtonElement).form?.reportValidity()) return;
    e.preventDefault(); setBusy(true); setErr(null);
    let organisationId = v.organisationId;
    if (!organisationId) {
      if (!buyerName) { setBusy(false); setErr("Type or choose a buyer."); return; }
      // Typing may beat the initial Account fetch (and that list is capped).
      // Resolve the current name before claiming it does not exist.
      const found = await api("GET", `/api/orgs?q=${encodeURIComponent(buyerName)}`);
      if (!found.ok) { setBusy(false); setErr(found.error ?? "Could not check existing buyer Accounts. Try again."); return; }
      organisationId = found.data.organisations.find((o: { id: string; name: string }) => o.name.localeCompare(buyerName, undefined, { sensitivity: "accent" }) === 0)?.id ?? "";
    }
    if (!organisationId) {
      if (!createBuyer) {
        setBusy(false); setDup(true);
        setErr(`No existing organisation exactly matches "${buyerName}". Create it as a new Account and use it as the buyer?`);
        return;
      }
      const created = await api("POST", "/api/orgs", { name: buyerName });
      if (created.ok) organisationId = created.data.organisation.id;
      else if (created.data?.needsConfirm === "duplicate" && created.data?.existingId) organisationId = created.data.existingId;
      else { setBusy(false); setErr(created.error ?? "Could not create the buyer Account."); return; }
      setV((current) => ({ ...current, organisationId, buyerName }));
    }
    const body: Record<string, unknown> = {
      name: v.name, organisationId, pipelineId: pipeline?.id, leaderId: v.leaderId, whyPursue: v.whyPursue,
      nextStep: { title: v.step, dueDate: v.due }, force,
    };
    if (pipeline?.key === "DEAL_BID") body.submissionDeadline = v.submissionDeadline || null;
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
    <form className="card new-deal-form" onSubmit={(e) => submit(e)}>
      <fieldset><legend>Opportunity</legend>
      <Field label="Deal name">{(id) => <input id={id} className="in" required maxLength={200} value={v.name} onChange={set("name")} />}</Field>
      <Field label="Client / Buyer" hint="Start typing to reuse an Account. If there is no exact match, you can create a linked Account here.">
        {(id) => <><input id={id} className="in" required maxLength={200} list={`${id}-buyers`} autoComplete="off" value={v.buyerName || selectedBuyer?.name || ""} onChange={setBuyer} /><datalist id={`${id}-buyers`}>{organisations.map((o) => <option key={o.id} value={o.name} />)}</datalist></>}
      </Field>
      <Field label="Pipeline">{(id) => <select id={id} className="in" value={pipeline?.id ?? ""} onChange={set("pipelineId")}>{pipes.data?.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      {pipeline?.key === "DEAL_BID" && <Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" required value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field>}
      <Field label="Opportunity type">{(id) => <select id={id} className="in" value={v.opportunityType} onChange={set("opportunityType")}><option value="">Unclassified</option>{OPPORTUNITY_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>
      <Field label="Leader">{(id) => <PeopleSelect id={id} label="Leader" value={v.leaderId} onChange={leaderId => setV({ ...v, leaderId })} people={(team.data?.people ?? []).map(p => ({ ...p, name: `${p.name}${p.id === me.id ? " (you)" : ""}` }))} />}</Field>
      </fieldset><fieldset><legend>Commercial details</legend>
      <Field label="Net Fee Revenue (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={v.netFeeRevenueUsd} onChange={set("netFeeRevenueUsd")} />}</Field>
      <Field label="PWin (%)">{(id) => <input id={id} className="in" type="number" min="0" max="100" step="1" value={v.probability} onChange={set("probability")} />}</Field>
      <Field label="Athena Entity">{(id) => <select id={id} className="in" value={v.athenaEntity} onChange={set("athenaEntity")}><option value="">Not specified</option>{ATHENA_ENTITIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>

      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Value (optional)">{(id) => <input id={id} className="in" type="number" min="1" value={v.value} onChange={set("value")} />}</Field>
        <Field label="Currency">{(id) => <select id={id} className="in" value={v.currency} onChange={set("currency")}><option>INR</option><option>USD</option><option>EUR</option></select>}</Field>
      </div>
      </fieldset><fieldset><legend>First next step</legend>
      <Field label="Why are we pursuing this?">{(id) => <input id={id} className="in" required maxLength={1000} value={v.whyPursue} onChange={set("whyPursue")} />}</Field>
      <Field label="First next step">{(id) => <input id={id} className="in" required value={v.step} onChange={set("step")} />}</Field>
      <Field label="Next step due">{(id) => <input id={id} className="in" type="date" required value={v.due} onChange={set("due")} />}</Field>

      </fieldset>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions"><Link className="btn ghost" href="/deals">Cancel</Link>
        <button className="btn" disabled={busy}>Create deal</button>
        {dup && !v.organisationId && <button type="button" className="btn ghost" disabled={busy} onClick={(e) => submit(e, false, true)}>Create buyer and deal</button>}
        {dup && v.organisationId && <button type="button" className="btn ghost" disabled={busy} onClick={(e) => submit(e, true)}>Create deal anyway</button>}
      </div>
    </form>
  );
}
export default function NewDeal() {
  return <Page className="new-deal-approved" title="New deal" beforeTitle={<nav aria-label="Breadcrumb"><Link href="/deals">Deals</Link> / New deal</nav>} sub="Start an opportunity with a clear next step."><Suspense><Form /></Suspense></Page>;
}
