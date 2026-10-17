"use client";
import { useEffect, useId, useRef, useState } from "react";

/** Centred dialog over a dimmed page. Escape and the dim area close it; focus moves in and returns. */
export function Modal({ onClose, small, label, children }: { onClose: () => void; small?: boolean; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("keydown", esc); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${small ? " sm" : ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref} style={{ outline: "none" }}>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, yes, danger, busy, error, onYes, onNo, children }: {
  title: string; body?: React.ReactNode; yes: string; danger?: boolean; busy?: boolean; error?: string | null;
  onYes: () => void; onNo: () => void; children?: React.ReactNode;
}) {
  return (
    <Modal small label={title} onClose={onNo}>
      <h2>{title}</h2>
      {body && <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{body}</div>}
      {children}
      {error && <div className="err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onNo}>Cancel</button>
        <button className={`btn${danger ? " danger" : ""}`} disabled={busy} onClick={onYes}>{yes}</button>
      </div>
    </Modal>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Small "..." menu. */
export function Menu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu" ref={box}>
      <button className="kebab" ref={btn} aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>⋯</button>
      {open && <div role="menu" onClick={(e) => e.stopPropagation()}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
