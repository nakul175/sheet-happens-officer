"use client";
import { useMemo, useState } from "react";
import { api } from "@/components/api";
import { Modal } from "@/components/ui";
import { dateLabel, wordsToDate } from "@/lib/datewords";

export type Target = { id: string; name: string };

/**
 * SHO-US-14.5. A title, Enter, done: the task lands in the last-used project, assigned to the person.
 * The date box takes words ("tomorrow", "fri") and shows the date it means before anything is saved.
 */
export function QuickAdd({ projects, lastId, onClose }: { projects: Target[]; lastId: string | null; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [pid, setPid] = useState(projects.find((p) => p.id === lastId)?.id ?? projects[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const date = useMemo(() => wordsToDate(when), [when]);
  const badDate = when.trim() !== "" && !date;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !title.trim() || badDate || !pid) return;
    setBusy(true); setErr(null);
    // No assigneeId: the server assigns the person who is adding it.
    const r = await api("POST", `/api/projects/${pid}/tasks`, { title: title.trim(), ...(date ? { dueDate: date } : {}) });
    setBusy(false);
    if (r.ok) { onClose(); window.dispatchEvent(new CustomEvent("sho:task-added", { detail: { projectId: pid } })); }
    else setErr(r.error ?? "Could not add the task.");
  }

  return (
    <Modal small label="New task" onClose={onClose}>
      <form onSubmit={submit} className="qa">
        <h2>New task</h2>
        <label className="lbl" htmlFor="qa-title">Title</label>
        <input id="qa-title" data-autofocus className="in" value={title} maxLength={500} autoComplete="off" placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} />
        <div className="qa-row">
          <div>
            <label className="lbl" htmlFor="qa-proj">Project</label>
            <select id="qa-proj" className="in" value={pid} onChange={(e) => setPid(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl" htmlFor="qa-date">Due (optional)</label>
            <input id="qa-date" className="in" value={when} autoComplete="off" placeholder="25/10/2026, 25 Oct, tomorrow" aria-describedby="qa-date-note qa-date-format" onChange={(e) => setWhen(e.target.value)} />
          </div>
        </div>
        <p id="qa-date-note" className={`hint qa-note${badDate ? " bad" : ""}`} role="status">
          {date ? `Due ${dateLabel(date, true)}` : badDate ? "Not a date I know. Try DD/MM/YYYY, 25 Oct, tomorrow, fri or YYYY-MM-DD." : "Assigned to you. Press Enter to add."}
        </p>
        <p id="qa-date-format" className="hint">Dates use DD/MM/YYYY. Without a year, use the current year in India time.</p>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !title.trim() || badDate || !pid}>Add task</button>
        </div>
      </form>
    </Modal>
  );
}
