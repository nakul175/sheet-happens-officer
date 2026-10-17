"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/components/api";
import { Modal } from "@/components/ui";
import "./undo.css";

type Toast = { id: string; ids?: string[]; label: string; notified: boolean }; // `ids` is a whole bulk change (SHO-US-14.11)
type Conflict = { field: string; before: string; after: string; now: string };
type Ask = { id: string; ids?: string[]; label: string; changedBy: string[]; conflicts: Conflict[] };

/** Ask the host to undo an action (used by the Activity screen). */
export function requestUndo(id: string) {
  window.dispatchEvent(new CustomEvent("sho:undo-request", { detail: { id } }));
}

/**
 * SHO-US-6.4. Shows "<action>. Undo" after a change, runs Undo, and shows the Before / After / Now warning
 * when somebody changed the same data since (with Keep their change and Undo anyway).
 */
export function UndoHost() {
  const [toast, setToast] = useState<Toast | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((t: Toast | null, ms = 10000) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    if (t) timer.current = setTimeout(() => setToast(null), ms);
  }, []);
  const say = useCallback((m: string) => {
    setToast(null);
    setNote(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 7000);
  }, []);

  const run = useCallback(async (id: string, anyway: boolean, ids?: string[]) => {
    const r = await api<{ label: string; noticesSent: boolean; needsConfirm?: string; conflicts?: Conflict[]; changedBy?: string[]; tooOld?: boolean }>(
      "POST", ids ? "/api/actions/bulk-undo" : `/api/actions/${id}/undo`, ids ? { ids, anyway } : { anyway });
    if (r.ok) {
      setAsk(null);
      say(`Undone: ${r.data.label.toLowerCase()}.${r.data.noticesSent ? " Notices already sent cannot be recalled." : ""}`);
      const ev = new CustomEvent("sho:undone", { cancelable: true, detail: { id } });
      if (window.dispatchEvent(ev)) setTimeout(() => window.location.reload(), 900);
    } else if (r.status === 409 && r.data.needsConfirm === "conflict") {
      setToast(null);
      setAsk({ id, ids, label: r.data.label ?? "this change", changedBy: r.data.changedBy ?? [], conflicts: r.data.conflicts ?? [] });
    } else {
      setAsk(null);
      say(r.error ?? "Could not undo.");
    }
  }, [say]);

  useEffect(() => {
    const onUndo = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; ids?: string[]; label: string; notified: boolean }>).detail;
      show({ id: d.id, ids: d.ids, label: d.label, notified: d.notified });
    };
    const onAsk = (e: Event) => run((e as CustomEvent<{ id: string }>).detail.id, false);
    window.addEventListener("sho:undo", onUndo);
    window.addEventListener("sho:undo-request", onAsk);
    return () => { window.removeEventListener("sho:undo", onUndo); window.removeEventListener("sho:undo-request", onAsk); };
  }, [show, run]);

  return (
    <>
      {toast && (
        <div className="undo-toast" role="status">
          <span>{toast.label}.{toast.notified && <small>Anyone already notified will not be un-notified.</small>}</span>
          <button onClick={() => run(toast.id, false, toast.ids)}>Undo</button>
        </div>
      )}
      {note && !toast && <div className="undo-toast" role="status"><span>{note}</span></div>}
      {ask && (
        <Modal small label="Undo conflict" onClose={() => setAsk(null)}>
          <h2>This changed after your action</h2>
          <p className="hint">
            {ask.changedBy.length ? `${ask.changedBy.join(", ")} changed it since. ` : ""}
            Undoing &ldquo;{ask.label.toLowerCase()}&rdquo; would replace their value.
          </p>
          <table className="undo-cmp">
            <thead><tr><th></th><th>Before your action</th><th>After your action</th><th>Now</th></tr></thead>
            <tbody>{ask.conflicts.map((c) => <tr key={c.field}><th>{c.field}</th><td>{c.before}</td><td>{c.after}</td><td>{c.now}</td></tr>)}</tbody>
          </table>
          <p className="hint">&ldquo;Undo anyway&rdquo; reverts only what you changed, keeps their other edits, and tells them you overrode their change.</p>
          <div className="actions">
            <button className="btn ghost" onClick={() => setAsk(null)}>Keep their change</button>
            <button className="btn" onClick={() => run(ask.id, true, ask.ids)}>Undo anyway</button>
          </div>
        </Modal>
      )}
    </>
  );
}
