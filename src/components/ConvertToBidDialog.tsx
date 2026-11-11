"use client";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, Modal } from "@/components/ui";
import { errorMessage, isVersionConflict } from "@/lib/version-error";
import type { previewBidConversion } from "@/lib/deals";

type Preview = Awaited<ReturnType<typeof previewBidConversion>>;
const LABELS: Record<string, string> = { whyPursue: "Why we are pursuing this", need: "Need", serviceLine: "Service line", value: "Value", currency: "Currency", probability: "Probability %", expectedClose: "Expected close", introducedBy: "Introduced by" };

export function ConvertToBidDialog({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const { data, error, loading } = useGet<Preview>(`/api/projects/${projectId}/convert-to-bid`);
  const [stageId, setStageId] = useState("");
  const [deadline, setDeadline] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const stage = data?.target.stages.find((s) => s.id === stageId);
  const required = new Set(stage?.requiredFields.filter((k) => k !== "submissionDeadline") ?? []);
  if (required.has("value") || required.has("currency")) { required.add("value"); required.add("currency"); }
  const fields = [...required];
  const value = (k: string) => values[k] ?? String(data?.details[k as keyof Preview["details"]] ?? "");
  const date = deadline ?? data?.details.submissionDeadline ?? "";
  const ready = !!stage && !stage.unsupportedFields.length && !!date && (!stage.needsReason || !!reason.trim()) && fields.every((k) => !!value(k).trim());
  async function commit() {
    if (!data || !ready || busy || stale) return;
    setBusy(true); setErr(null);
    const facts = Object.fromEntries(fields.map((k) => [k, k === "value" || k === "probability" ? Number(value(k)) : value(k)]));
    const r = await api("POST", `/api/projects/${projectId}/convert-to-bid`, { expectedRevision: data.revision, stageId, submissionDeadline: date, reason, fields: facts });
    setBusy(false);
    if (r.ok) { onDone(); return; }
    setStale(isVersionConflict(r.status, r.data));
    setErr(errorMessage(r.error, "Could not convert the deal."));
    setReview(false);
  }
  return <Modal label="Convert to Bid" onClose={() => { if (!busy) onClose(); }}>
    <h2>{review ? "Review conversion" : "Convert to Bid"}</h2>
    {loading && <p role="status">Loading current deal and Bid stages…</p>}
    {error && <p className="err" role="alert">{errorMessage(error, "Could not load conversion.")}</p>}
    {data && <>
      <p><b>From:</b> {data.source.pipeline} / {data.source.stage}</p>
      {review ? <>
        <p><b>To:</b> {data.target.name} / {stage?.name}</p>
        <p><b>Submission deadline:</b> {date}</p>
        {fields.map((k) => <p key={k}><b>{LABELS[k] ?? k}:</b> {value(k)}</p>)}
        {reason.trim() && <p><b>Reason:</b> {reason.trim()}</p>}
        <p>The same deal, people, tasks, notes and history will be kept. This conversion cannot be undone through this flow.</p>
      </> : <form id="bid-conversion" onSubmit={(e) => { e.preventDefault(); if (ready) { setReview(true); setErr(null); } }}>
        <Field label="Bid stage (required)">{(id) => <select id={id} className="in" required value={stageId} disabled={busy || stale} onChange={(e) => { setStageId(e.target.value); setValues({}); setErr(null); }}>
          <option value="">Choose a Bid stage</option>
          {data.target.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>}</Field>
        {!data.target.stages.length && <p role="alert">No open Bid stages are available.</p>}
        {stage && <p><b>To:</b> {data.target.name} / {stage.name}</p>}
        {!!stage?.unsupportedFields.length && <p className="err" role="alert">This stage requires unsupported fields: {stage.unsupportedFields.join(", ")}. Choose another stage or ask an Admin to review its requirements.</p>}
        <Field label="Submission deadline (required)">{(id) => <input id={id} className="in" type="date" required value={date} disabled={busy || stale} onChange={(e) => setDeadline(e.target.value)} />}</Field>
        {fields.filter((k) => LABELS[k]).map((k) => <Field key={k} label={`${LABELS[k]} (required)`}>{(id) => k === "currency"
          ? <select id={id} className="in" required value={value(k)} disabled={busy || stale} onChange={(e) => setValues({ ...values, [k]: e.target.value })}><option value="">Choose</option><option>INR</option><option>USD</option><option>EUR</option></select>
          : <input id={id} className="in" required type={k === "value" || k === "probability" ? "number" : k === "expectedClose" ? "date" : "text"} min={k === "value" ? "0.01" : k === "probability" ? "0" : undefined} max={k === "probability" ? "100" : undefined} step={k === "value" ? "any" : undefined} value={value(k)} disabled={busy || stale} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />}</Field>)}
        <Field label={stage?.needsReason ? "Reason (required)" : "Reason (optional)"}>{(id) => <textarea id={id} className="in" required={stage?.needsReason} maxLength={1000} value={reason} disabled={busy || stale} onChange={(e) => setReason(e.target.value)} />}</Field>
      </form>}
    </>}
    {err && <p className="err" role="alert">{err}</p>}
    <div className="actions">
      <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
      {review && <button className="btn ghost" disabled={busy} onClick={() => setReview(false)}>Back</button>}
      {review
        ? <button className="btn" disabled={busy || stale} onClick={() => void commit()}>{busy ? "Converting…" : "Confirm conversion"}</button>
        : <button className="btn" type="submit" form="bid-conversion" disabled={!ready || busy || stale}>Review conversion</button>}
    </div>
  </Modal>;
}
