"use client";
import { useId, useState } from "react";
import { api } from "@/components/api";
import { Field, Modal } from "@/components/ui";
import { submissionDeadlineFields, submissionDeadlineEdit, SUBMISSION_TIME_ZONE_LABEL } from "@/lib/submission-deadline";
export function ConvertDealToBid({ projectId, pipelineId, stageId, deadline, onClose, onDone }: {
  projectId: string; pipelineId: string; stageId: string; deadline: string | null; onClose: () => void; onDone: () => void;
}) {
  const formId = useId(), initial = submissionDeadlineFields(deadline);
  const [date, setDate] = useState(initial.date), [time, setTime] = useState(initial.time);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !confirmed || !date) return;
    let submissionDeadline: string | null;
    try { submissionDeadline = submissionDeadlineEdit(deadline, date, time); }
    catch { setError("Choose a valid submission date and optional time."); return; }
    setBusy(true); setError(null);
    try {
      const result = await api("POST", `/api/projects/${projectId}/convert-to-bid`, { expectedPipelineId: pipelineId, expectedStageId: stageId, confirmed: true, submissionDeadline });
      if (result.ok) onDone(); else setError(result.error ?? "Could not convert this deal.");
    } catch { setError("Could not convert this deal. Please try again."); }
    finally { setBusy(false); }
  }
  return <Modal onClose={onClose} label="Convert Proactive deal to Bid">
    <form id={formId} onSubmit={save}>
      <h2>Convert to Bid</h2>
      <p>This moves this deal to Bid → Leads. It keeps its ID, members, tasks, Buyer and other parties. Its current stage remains in history. This action has no Undo shortcut.</p>
      <Field label="Submission deadline">{(id) => <input className="in" id={id} type="date" required value={date} onChange={(e) => { setDate(e.target.value); if (!e.target.value) setTime(""); }} />}</Field>
      <Field label={`Submission time (optional) · ${SUBMISSION_TIME_ZONE_LABEL}`}>{(id) => <input className="in" id={id} type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />}</Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I confirm this deal should move from Proactive to Bid Leads.</label>
      {error && <div className="err" role="alert">{error}</div>}
    </form>
    <div className="actions"><button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn" form={formId} disabled={busy || !confirmed || !date}>{busy ? "Converting…" : "Convert to Bid"}</button></div>
  </Modal>;
}
