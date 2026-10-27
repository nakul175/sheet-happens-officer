"use client";
import { useEffect, useRef, useState } from "react";
import { PRIORITY, initials } from "@/components/api";
import "./avatars.css";
import { api } from "@/components/api";
import { errorMessage, isVersionConflict } from "@/lib/version-error";
import { Confirm } from "@/components/ui";

/** Tick circle. Calls complete (or reopen) on the version the row shows, and asks before completing open subtasks. */
export function Tick({ id, title, done, allowed, version, onDone, onStale, disabledReason }: {
  id: string; title: string; done: boolean; allowed: boolean; version: string; onDone: () => void; onStale?: () => void; disabledReason?: string;
}) {
  const [ask, setAsk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(all = false) {
    setBusy(true);
    const r = await api("POST", `/api/tasks/${id}/${done ? "reopen" : "complete"}`, done ? {} : { completeAll: all, expectedUpdatedAt: version });
    setBusy(false);
    if (r.ok) { setAsk(null); setErr(null); onDone(); }
    else if (isVersionConflict(r.status, r.data)) { setAsk(null); setErr(errorMessage(r.error, "This task changed while you were editing it.")); onStale?.(); }
    else if (r.status === 409 && r.data.needsConfirm === "open_subtasks") setAsk(r.data.openSubtasks as number);
    else setErr(errorMessage(r.error, "Could not update the task."));
  }
  return (
    <>
      <button className={`tick${done ? " done" : ""}${allowed ? "" : " off"}`} disabled={!allowed || busy}
        aria-label={allowed ? `${done ? "Reopen" : "Complete"} "${title}"` : disabledReason ? `"${title}": ${disabledReason}` : `"${title}" can only be closed by its approver`}
        title={allowed ? undefined : disabledReason ?? "Only the approver or the project Leader can close this task"}
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

const PRIORITY_ICON: Record<string, string> = { LOW: "↓", MEDIUM: "−", HIGH: "↑", URGENT: "⚠" };
/** Visible icon and label retain all four existing priority values in every density. */
export function Pri({ p }: { p: string }) {
  return <span className={`pri priority-badge pri-${p}`} title={PRIORITY[p] ?? "Not set"}><span aria-hidden="true">{PRIORITY_ICON[p] ?? "−"}</span><span className="pri-t">{PRIORITY[p] ?? "Not set"}</span></span>;
}

/** Selects only the caller's displayed task IDs; completion is a separate control. */
export function SectionSelection({ selected, total, label, onChange, disabled = false }: { selected: number; total: number; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const mixed = selected > 0 && selected < total;
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <label className="selall"><input ref={input} type="checkbox" aria-label={label} aria-checked={mixed ? "mixed" : selected === total && total > 0} checked={total > 0 && selected === total} disabled={disabled || total === 0} onChange={e => onChange(e.target.checked)} /><span className="section-selection-mark" aria-hidden="true">{mixed ? "−" : selected === total && total > 0 ? "✓" : ""}</span></label>;
}
