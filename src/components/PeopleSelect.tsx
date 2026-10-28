"use client";
import { useEffect, useId, useRef, useState } from "react";
import "./people-select.css";
export type PersonChoice = { id: string; name: string; email?: string };
export const personText = (person: { name: string; email?: string }) => `${person.name}${person.email ? ` — ${person.email}` : ""}`;
/** Presentation only: callers retain the eligible IDs and the existing change/save contract. */
export function PersonIdentity({ person }: { person: PersonChoice }) {
  return <span className="person-identity"><span>{person.name}</span>{person.email && <small>{person.email}</small>}</span>;
}
export function PeopleSelect({ id, label, people, value, onChange, disabled = false }: { id: string; label: string; people: PersonChoice[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const listId = useId(), selectedId = useId(), labelId = useId();
  const box = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const selected = people.find(p => p.id === value);
  const shown = people.filter(p => `${p.name} ${p.email ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = (focus = false) => { setOpen(false); setQuery(""); if (focus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setQuery(""); } };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  function navigate(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    if (!options.length) return;
    // Home/End in the search input still edit its text normally.
    if (e.target === search.current && (e.key === "Home" || e.key === "End")) return;
    e.preventDefault(); const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowDown" ? (at + 1) % options.length : at <= 0 ? options.length - 1 : at - 1;
    options[next]?.focus();
  }
  return <div className="people-select" ref={box} onKeyDown={navigate} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(); }}>
    <button id={id} ref={trigger} type="button" className="in people-select-trigger" aria-labelledby={`${labelId} ${selectedId}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen(v => !v)} onKeyDown={e => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); e.stopPropagation(); setOpen(true); } }}>
      <span id={selectedId}>{selected ? <PersonIdentity person={selected} /> : "Choose a person"}</span><span className="select-chevron" aria-hidden="true" />
      <span id={labelId} className="sr-only">{label}</span>
    </button>
    {open && <div className="people-select-popup"><input ref={search} className="in" aria-label={`Search ${label.toLowerCase()} choices`} placeholder="Search name or email" autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} />
      <div id={listId} role="listbox" aria-label={`${label} choices`}>
        {shown.map(p => <button type="button" key={p.id} role="option" aria-selected={p.id === value} onClick={() => { onChange(p.id); close(true); }}><PersonIdentity person={p} />{p.id === value && <span aria-hidden="true">✓</span>}</button>)}
        {!shown.length && <p className="hint" role="status">No matching people.</p>}
      </div>
    </div>}
  </div>;
}
