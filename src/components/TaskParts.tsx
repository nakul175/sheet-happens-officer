"use client";
import { useEffect, useRef, useState } from "react";
import { PRIORITY, initials } from "@/components/api";
import "./avatars.css";
import { api, isVersionConflict } from "@/components/api";
import { Confirm } from "@/components/ui";

/** Tick circle. Calls complete (or reopen) on the version the row shows, and asks before completing open subtasks. */
export function Tick({ id, title, done, allowed, version, onDone, onStale }: {
  id: string; title: string; done: boolean; allowed: boolean; version: string; onDone: () => void; onStale?: () => void;
}) {
  const [ask, setAsk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(all = false) {
    setBusy(true);
    const r = await api("POST", `/api/tasks/${id}/${done ? "reopen" : "complete"}`, done ? {} : { completeAll: all, expectedUpdatedAt: version });
    setBusy(false);
    if (r.ok) { setAsk(null); setErr(null); onDone(); }
    else if (isVersionConflict(r.status, r.data)) { setAsk(null); setErr(r.error ?? "This task changed while you were editing it."); onStale?.(); }
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

type Person = { id: string; name: string };
/** SHO-US-22.9: assignee and collaborator avatars. Tapping the group (or pressing Enter) shows their names; hover is not needed. */
export function AvatarGroup({ assignee, collaborators, className }: { assignee: Person; collaborators: Person[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span className={`avwrap ${className ?? ""}`} ref={box}>
      <button type="button" className="avs avbtn" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={(e) => e.stopPropagation()}>
        <span className="sr-only">{`People: ${assignee.name}${collaborators.length ? ` and ${collaborators.length} collaborator${collaborators.length === 1 ? "" : "s"}` : ""}. Show names`}</span>
        <span className="av sm" aria-hidden>{initials(assignee.name)}</span>
        {collaborators.slice(0, 3).map((c) => <span key={c.id} className="av sm collab" aria-hidden>{initials(c.name)}</span>)}
        {collaborators.length > 3 && <span className="av sm collab" aria-hidden>+{collaborators.length - 3}</span>}
      </button>
      {open && (
        <span className="avpop" role="status" onClick={(e) => e.stopPropagation()}>
          <span><b>Assignee</b> {assignee.name}</span>
          {collaborators.length > 0 && <span><b>With</b> {collaborators.map((c) => c.name).join(", ")}</span>}
        </span>
      )}
    </span>
  );
}

const LEVEL: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };
/** SHO-US-14.12: priority as a small bar icon plus its word (the word is hidden on compact rows but stays for screen readers). Not link-coloured. */
export function Pri({ p }: { p: string }) {
  const n = LEVEL[p] ?? 2;
  return (
    <span className={`pri pri-${p}`} title={PRIORITY[p]}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
        {[0, 1, 2, 3].map((i) => <rect key={i} x={0.75 + i * 3} y={11 - (3 + i * 2.4)} width="2.5" height={3 + i * 2.4 - 0.25} rx=".5" fill={i < n ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1" />)}
      </svg>
      <span className="pri-t">{PRIORITY[p]}</span>
    </span>
  );
}
