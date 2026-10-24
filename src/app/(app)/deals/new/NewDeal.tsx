"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, todayIST, useGet } from "@/components/api";
import { Field } from "@/components/ui";
import { Page, useMe } from "../../Shell";

function Form() {
  const me = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string }[] }>("/api/deals/pipelines");
  const [v, setV] = useState({ name: "", organisationId: sp.get("org") ?? "", pipelineId: "", leaderId: me.id, whyPursue: "", step: "", due: todayIST(), submissionDeadline: "", value: "", currency: "INR" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const pipeline = pipes.data?.pipelines.find((p) => p.id === (v.pipelineId || pipes.data?.pipelines[0]?.id));
  async function submit(e: React.FormEvent, force = false) {
    e.preventDefault(); setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      name: v.name, organisationId: v.organisationId, pipelineId: pipeline?.id, leaderId: v.leaderId, whyPursue: v.whyPursue,
      nextStep: { title: v.step, dueDate: v.due }, force,
    };
    if (pipeline?.key === "DEAL_BID") body.submissionDeadline = v.submissionDeadline || null;
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
      <Field label="Organisation (buyer)" hint="Not listed? Add it under Accounts first.">
        {(id) => <select id={id} className="in" required value={v.organisationId} onChange={set("organisationId")}><option value="">Choose</option>{orgs.data?.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      </Field>
      <p style={{ marginTop: -8, fontSize: 14 }}><Link href="/accounts">Open Accounts to add a buyer</Link></p>
      <Field label="Pipeline">{(id) => <select id={id} className="in" value={pipeline?.id ?? ""} onChange={set("pipelineId")}>{pipes.data?.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
      {pipeline?.key === "DEAL_BID" && <Field label="Submission deadline">{(id) => <input id={id} className="in" type="date" required value={v.submissionDeadline} onChange={set("submissionDeadline")} />}</Field>}
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
        <button className="btn" disabled={busy}>Create deal</button>
        {dup && <button type="button" className="btn ghost" disabled={busy} onClick={(e) => submit(e, true)}>Create anyway</button>}
      </div>
    </form>
  );
}
export default function NewDeal() {
  return <Page title="New deal" sub={<Link href="/deals">← Deals</Link>}><Suspense><Form /></Suspense></Page>;
}
