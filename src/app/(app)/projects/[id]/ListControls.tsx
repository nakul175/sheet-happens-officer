"use client";
import { useId, useState } from "react";
import { PRIORITY } from "@/components/api";
import { FLAG_KEYS, FLAG_LABEL, PRIORITY_KEYS, isFiltered, type Group, type ListState } from "./listview";
import "./lists.css";

type Member = { userId: string; name: string; role: string; active: boolean };

/** SHO-US-14.9: Filter, Sort and Group. Every choice is written to the page URL by `onChange`, so a copied link gives the same list. */
export function ListControls({ state, members, onChange, showGroup, found, onSave, saveWhy, children }: {
  state: ListState; members: Member[]; onChange: (patch: Partial<ListState>) => void; showGroup: boolean;
  found: number | null; onSave?: () => void; saveWhy?: string | null; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const workers = members.filter((m) => m.active && (m.role === "LEADER" || m.role === "EDITOR"));
  const gone = state.assignee && !workers.some((m) => m.userId === state.assignee);
  const goneName = members.find((m) => m.userId === state.assignee);
  const filtered = isFiltered(state);
  const n = state.flags.length + (state.assignee ? 1 : 0) + (state.priority ? 1 : 0);
  const toggle = (f: string) => onChange({ flags: state.flags.includes(f) ? state.flags.filter((x) => x !== f) : [...state.flags, f] });
  const clear = () => onChange({ assignee: "", flags: [], priority: "" });
  return (
    <div className="lc">
      <div className="lc-bar">
        <button type="button" className="btn ghost" aria-expanded={open} aria-controls={`${id}-p`} onClick={() => setOpen((v) => !v)}>
          Filter{n > 0 && <span className="lc-n">{n}</span>}
        </button>
        <label className="lc-sel">Sort
          <select className="in" value={state.sort} onChange={(e) => onChange({ sort: e.target.value as "date" | "priority" })}>
            <option value="date">Due date</option>
            <option value="priority">Priority</option>
          </select>
        </label>
        {showGroup && (
          <label className="lc-sel">Group by
            <select className="in" value={state.group} onChange={(e) => onChange({ group: e.target.value as Group })}>
              <option value="section">Section</option>
              <option value="assignee">Assignee</option>
              <option value="week">Due week</option>
            </select>
          </label>
        )}
        {children}
        {onSave && (
          <button type="button" className="btn ghost" disabled={!!saveWhy} onClick={onSave} aria-describedby={saveWhy ? `${id}-why` : undefined}>Save view</button>
        )}
      </div>
      {saveWhy && <p className="hint" id={`${id}-why`}>{saveWhy}</p>}
      {open && (
        <div className="lc-panel" id={`${id}-p`} role="group" aria-label="Filters">
          <label className="lc-f">Person
            <select className="in" value={state.assignee} onChange={(e) => onChange({ assignee: e.target.value })}>
              <option value="">Anyone</option>
              {gone && <option value={state.assignee}>{goneName?.name ?? "Unknown person"} (no longer on project)</option>}
              {workers.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </label>
          <label className="lc-f">Priority
            <select className="in" value={state.priority} onChange={(e) => onChange({ priority: e.target.value })}>
              <option value="">Any priority</option>
              {PRIORITY_KEYS.map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}
            </select>
          </label>
          <fieldset className="lc-f">
            <legend>Show only</legend>
            <div className="lc-checks">
              {FLAG_KEYS.map((f) => (
                <label key={f} className="lc-check"><input type="checkbox" checked={state.flags.includes(f)} onChange={() => toggle(f)} />{FLAG_LABEL[f]}</label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {filtered && (
        <div className="lc-chips" aria-label="Active filters">
          {state.assignee && (
            <button type="button" className="chip lc-chip" onClick={() => onChange({ assignee: "" })} aria-label={`Remove filter ${goneName?.name ?? "person"}`}>
              {gone ? `${goneName?.name ?? "A person"}: person no longer on project` : workers.find((m) => m.userId === state.assignee)?.name ?? "Person"} ×
            </button>
          )}
          {state.priority && <button type="button" className="chip lc-chip" onClick={() => onChange({ priority: "" })} aria-label={`Remove filter ${PRIORITY[state.priority]} priority`}>{PRIORITY[state.priority]} priority ×</button>}
          {state.flags.map((f) => <button key={f} type="button" className="chip lc-chip" onClick={() => toggle(f)} aria-label={`Remove filter ${FLAG_LABEL[f]}`}>{FLAG_LABEL[f]} ×</button>)}
          {found !== null && <span className="hint" role="status">{found} found</span>}
          <button type="button" className="link" onClick={clear}>Clear filters</button>
        </div>
      )}
    </div>
  );
}
