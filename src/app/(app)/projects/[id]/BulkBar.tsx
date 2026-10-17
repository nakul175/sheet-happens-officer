"use client";
// SHO-US-14.11: the bar that appears when tasks are ticked. The server does the work, skips what the person may not change,
// and answers with a sentence that says exactly what happened; one Undo toast reverses the whole group.
import { useState } from "react";
import { api, todayIST } from "@/components/api";
import { Field, Modal } from "@/components/ui";

type Person = { userId: string; name: string; role: string; active: boolean };
type Sec = { id: string; name: string; isDone: boolean };
export type BulkResult = { message: string; skipped: { id: string; title: string; reason: string }[]; changed: number };
type Kind = "assign" | "date" | "move" | "complete";
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export function BulkBar({ projectId, ids, people, sections, onClear, onDone }: {
  projectId: string; ids: string[]; people: Person[]; sections: Sec[]; onClear: () => void; onDone: (r: BulkResult) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [who, setWho] = useState("");
  const [sec, setSec] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workers = people.filter((m) => m.active && (m.role === "LEADER" || m.role === "EDITOR"));
  const open = sections.filter((s) => !s.isDone);
  const n = ids.length;
  const close = () => { setKind(null); setErr(null); };

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    const r = await api<BulkResult & { undoIds: string[]; label: string | null; notified: boolean }>("POST", `/api/projects/${projectId}/tasks/bulk`, { taskIds: ids, ...body });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Could not change the tasks."); return; }
    if (r.data.undoIds.length && r.data.label) {
      window.dispatchEvent(new CustomEvent("sho:undo", { detail: { id: r.data.undoIds[0], ids: r.data.undoIds, label: r.data.label, notified: r.data.notified } }));
    }
    close();
    onDone({ message: r.data.message, skipped: r.data.skipped, changed: r.data.changed });
  }
  const today = todayIST();
  const dateBtn = (label: string, due: string | null) => <button type="button" className="btn ghost" disabled={busy} onClick={() => send({ action: "date", dueDate: due })}>{label}</button>;
  return (
    <>
      <div className="bulkbar" role="region" aria-label="Selected tasks">
        <strong role="status">{n} selected</strong>
        <span className="bulk-acts">
          <button className="btn" onClick={() => { setWho(workers[0]?.userId ?? ""); setKind("assign"); }}>Assign</button>
          <button className="btn" onClick={() => setKind("date")}>Set date</button>
          <button className="btn" onClick={() => { setSec(open[0]?.id ?? ""); setKind("move"); }}>Move section</button>
          <button className="btn" onClick={() => setKind("complete")}>Complete</button>
          <button className="btn ghost" onClick={onClear}>Clear</button>
        </span>
      </div>
      {kind === "assign" && (
        <Modal small label="Assign tasks" onClose={close}>
          <h2>Assign {n} task{n === 1 ? "" : "s"}</h2>
          <form onSubmit={(e) => { e.preventDefault(); send({ action: "assign", assigneeId: who }); }}>
            <Field label="Assign to">{(id) => <select id={id} className="in" value={who} onChange={(e) => setWho(e.target.value)}>{workers.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>}</Field>
            {err && <div className="err" role="alert">{err}</div>}
            <div className="actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn" disabled={busy || !who}>Assign {n}</button></div>
          </form>
        </Modal>
      )}
      {kind === "date" && (
        <Modal small label="Set date" onClose={close}>
          <h2>Set the date on {n} task{n === 1 ? "" : "s"}</h2>
          <div className="bulk-dates">
            {dateBtn("Today", today)}{dateBtn("Tomorrow", addDays(today, 1))}{dateBtn("Next week", addDays(today, 7))}{dateBtn("No date", null)}
          </div>
          <Field label="Or pick a date">{(id) => <input id={id} className="in" type="date" disabled={busy} onChange={(e) => { if (e.target.value) send({ action: "date", dueDate: e.target.value }); }} />}</Field>
          {err && <div className="err" role="alert">{err}</div>}
          <div className="actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button></div>
        </Modal>
      )}
      {kind === "move" && (
        <Modal small label="Move section" onClose={close}>
          <h2>Move {n} task{n === 1 ? "" : "s"}</h2>
          <form onSubmit={(e) => { e.preventDefault(); send({ action: "move", sectionId: sec }); }}>
            <Field label="Move to section">{(id) => <select id={id} className="in" value={sec} onChange={(e) => setSec(e.target.value)}>{open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
            {err && <div className="err" role="alert">{err}</div>}
            <div className="actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn" disabled={busy || !sec}>Move {n}</button></div>
          </form>
        </Modal>
      )}
      {kind === "complete" && (
        <Modal small label="Complete tasks" onClose={close}>
          <h2>Complete {n} task{n === 1 ? "" : "s"}?</h2>
          <p className="hint">Tasks you may not close, or that have open subtasks, are skipped and listed. Undo reverses all of it.</p>
          {err && <div className="err" role="alert">{err}</div>}
          <div className="actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn" disabled={busy} onClick={() => send({ action: "complete" })}>Complete {n}</button></div>
        </Modal>
      )}
    </>
  );
}
