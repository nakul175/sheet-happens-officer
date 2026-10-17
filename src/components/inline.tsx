"use client";
// SHO-US-14.8: change the assignee, date or priority right in a list row. The server still decides who may edit;
// the cells are only read-only here when the server would refuse anyway (see `inlineEditable`).
import { useEffect, useRef, useState } from "react";
import { PRIORITY, api, dueState, isOverdue, todayIST } from "@/components/api";
import "./inline.css";

export type Cell = { id: string; title: string; assignee: { id: string; name: string }; dueDate: string | null; priority: string; updatedAt: string; completedAt: string | null; awaitingApproval: boolean };
export type Person = { userId: string; name: string; role: string; active: boolean };
type Change = { kind: "assign"; assigneeId: string } | { kind: "patch"; patch: Record<string, unknown> };
export type StaleNote = { taskId: string; title: string; who: string; change: Change; what: string };

/** Viewers cannot edit. A task awaiting approval is held by its approver, so only the Leader holding it edits it in place. */
export function inlineEditable(role: string, t: Pick<Cell, "completedAt" | "awaitingApproval" | "assignee">, meId: string) {
  if (role === "VIEWER" || t.completedAt) return false;
  return !t.awaitingApproval || (role === "LEADER" && t.assignee.id === meId);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Runs inline edits and holds the "changed while you were editing" notice. The Undo toast comes from the API response. */
export function useInlineEdit(onChanged: () => void) {
  const [stale, setStale] = useState<StaleNote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(t: Cell, change: Change, what = "") {
    setBusy(true);
    const r = change.kind === "assign"
      ? await api("POST", `/api/tasks/${t.id}/assign`, { assigneeId: change.assigneeId, expectedUpdatedAt: t.updatedAt })
      : await api("PATCH", `/api/tasks/${t.id}`, { ...change.patch, expectedUpdatedAt: t.updatedAt });
    setBusy(false);
    if (r.ok) { setErr(null); setStale(null); onChanged(); return; }
    if (r.status === 409 && r.data.stale) {
      setStale({ taskId: t.id, title: t.title, who: r.data.changedBy ?? "Someone", change, what });
      setErr(null);
      onChanged();
    } else setErr(r.error ?? "Could not save the change.");
  }
  /** Re-apply the refused edit on top of the task's current version. */
  async function reapply() {
    if (!stale) return;
    const r = await api<{ task: Cell }>("GET", `/api/tasks/${stale.taskId}`);
    if (!r.ok) { setErr(r.error ?? "Could not load the task."); return; }
    await run(r.data.task, stale.change, stale.what);
  }
  const notice = (stale || err) && (
    <div role="alert" className={stale ? "box warn" : "err"} style={stale ? { marginBottom: 12 } : undefined}>
      {stale ? <>
        {stale.who} changed &ldquo;{stale.title}&rdquo; while you were editing. Your change was not saved; the row now shows the current values.
        <div style={{ marginTop: 6 }}>Your edit was: {stale.what}.{" "}
          <button className="link" disabled={busy} onClick={reapply}>Re-apply my edit</button>{" · "}
          <button className="link" onClick={() => setStale(null)}>Dismiss</button></div>
      </> : <>{err} <button className="link" onClick={() => setErr(null)}>Dismiss</button></>}
    </div>
  );
  return { run, notice, busy };
}

function Pop({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button, input")?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  return (
    <div className="ic-pop" role="dialog" aria-label={label} ref={box} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const f = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
          const i = f.indexOf(document.activeElement as HTMLElement);
          if (f.length) { e.preventDefault(); f[(i + (e.key === "ArrowDown" ? 1 : f.length - 1)) % f.length].focus(); }
        }
      }}>
      {children}
    </div>
  );
}

/** The three cells of one row. Focus returns to the cell after the popover closes. */
export function InlineCells({ t, people, editable, onEdit }: { t: Cell; people: Person[]; editable: boolean; onEdit: (t: Cell, c: Change, what: string) => void }) {
  const [open, setOpen] = useState<null | "who" | "due" | "pri">(null);
  const refs = { who: useRef<HTMLButtonElement>(null), due: useRef<HTMLButtonElement>(null), pri: useRef<HTMLButtonElement>(null) };
  const close = () => { const k = open; setOpen(null); if (k) setTimeout(() => refs[k].current?.focus(), 0); };
  const workers = people.filter((m) => m.active && (m.role === "LEADER" || m.role === "EDITOR"));
  const today = todayIST();
  const pick = (c: Change, what: string) => { close(); onEdit(t, c, what); };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const cell = (k: "who" | "due" | "pri", text: React.ReactNode, cls: string | undefined, aria: string) => editable ? (
    <span className="ic-wrap" onClick={stop}>
      <button ref={refs[k]} type="button" className={`ic-cell${cls ? ` ${cls}` : ""}`} aria-haspopup="dialog" aria-expanded={open === k} aria-label={aria}
        onClick={(e) => { e.stopPropagation(); setOpen(open === k ? null : k); }}>{text}</button>
      {open === k && k === "who" && (
        <Pop label="Choose assignee" onClose={close}>
          {workers.map((m) => <button key={m.userId} type="button" aria-pressed={m.userId === t.assignee.id} onClick={() => m.userId === t.assignee.id ? close() : pick({ kind: "assign", assigneeId: m.userId }, `Assignee: ${m.name}`)}>{m.name}</button>)}
        </Pop>
      )}
      {open === k && k === "due" && (
        <Pop label="Choose due date" onClose={close}>
          <button type="button" onClick={() => pick({ kind: "patch", patch: { dueDate: today } }, "Due date: Today")}>Today</button>
          <button type="button" onClick={() => pick({ kind: "patch", patch: { dueDate: addDays(today, 1) } }, "Due date: Tomorrow")}>Tomorrow</button>
          <button type="button" onClick={() => pick({ kind: "patch", patch: { dueDate: addDays(today, 7) } }, "Due date: Next week")}>Next week</button>
          <label className="ic-date">Pick a date
            <input className="in" type="date" defaultValue={t.dueDate ?? ""} onChange={(e) => { if (e.target.value) pick({ kind: "patch", patch: { dueDate: e.target.value } }, `Due date: ${e.target.value}`); }} />
          </label>
          {t.dueDate && <button type="button" onClick={() => pick({ kind: "patch", patch: { dueDate: null } }, "Due date: cleared")}>No date</button>}
        </Pop>
      )}
      {open === k && k === "pri" && (
        <Pop label="Choose priority" onClose={close}>
          {(["URGENT", "HIGH", "MEDIUM", "LOW"] as const).map((p) => <button key={p} type="button" aria-pressed={p === t.priority} onClick={() => p === t.priority ? close() : pick({ kind: "patch", patch: { priority: p } }, `Priority: ${PRIORITY[p]}`)}>{PRIORITY[p]}</button>)}
        </Pop>
      )}
    </span>
  ) : <span className={cls}>{text}</span>;
  return (
    <>
      {cell("who", t.assignee.name, undefined, `Assignee ${t.assignee.name}. Change`)}
      {cell("pri", PRIORITY[t.priority], `pri-${t.priority}`, `Priority ${PRIORITY[t.priority]}. Change`)}
      {cell("due", dueState(t.dueDate, !!t.completedAt), !t.completedAt && isOverdue(t.dueDate) ? "over" : undefined, `Due date ${dueState(t.dueDate, !!t.completedAt)}. Change`)}
    </>
  );
}
