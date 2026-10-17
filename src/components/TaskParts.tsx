"use client";
import { useState } from "react";
import { api } from "@/components/api";
import { Confirm } from "@/components/ui";

/** Tick circle. Calls complete (or reopen) and asks before completing open subtasks. */
export function Tick({ id, title, done, allowed, onDone }: { id: string; title: string; done: boolean; allowed: boolean; onDone: () => void }) {
  const [ask, setAsk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(all = false) {
    setBusy(true);
    const r = await api("POST", `/api/tasks/${id}/${done ? "reopen" : "complete"}`, done ? {} : { completeAll: all });
    setBusy(false);
    if (r.ok) { setAsk(null); setErr(null); onDone(); }
    else if (r.status === 409 && r.data.needsConfirm === "open_subtasks") setAsk(r.data.openSubtasks as number);
    else setErr(r.error ?? "Could not update the task.");
  }
  return (
    <>
      <button className={`tick${done ? " done" : ""}${allowed ? "" : " off"}`} disabled={!allowed || busy}
        aria-label={allowed ? `${done ? "Reopen" : "Complete"} "${title}"` : `"${title}" can only be closed by its approver`}
        title={allowed ? undefined : "Only the approver or the project Leader can close this task"}
        onClick={(e) => { e.stopPropagation(); go(); }}>{done ? "✓" : ""}</button>
      {ask !== null && (
        <Confirm title="Open subtasks" yes="Complete them all" busy={busy} onNo={() => setAsk(null)}
          body={`"${title}" has ${ask} open subtask${ask === 1 ? "" : "s"}. Complete them too?`} onYes={() => go(true)} />
      )}
      {err && <span className="err" role="alert" style={{ margin: 0 }}>{err}</span>}
    </>
  );
}
