"use client";
import { useEffect, useId, useRef, useState } from "react";

/** Centred dialog over a dimmed page. Escape and the dim area close it; focus moves in and returns. */
export function Modal({ onClose, small, label, describedBy, children }: { onClose: () => void; small?: boolean; label: string; describedBy?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current)?.focus(); // SHO-US-14.5: a dialog can name the field that gets focus
    // SHO-US-22.7: the page behind a dialog must not scroll.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      // SHO-US-14.3: keep Tab inside the dialog.
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (e.shiftKey && (at === first || at === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      else if (!ref.current.contains(at)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("keydown", keys); document.body.style.overflow = before; prev?.focus?.(); };
  }, [onClose]);
  // SHO-2738: on a phone the keyboard shortens the visible area, not the page, so the sheet is sized from visualViewport
  // (--vvh/--vvt, the same pair the Concierge sheet uses) and the footer is pinned to the bottom of that area.
  // On a desktop visualViewport is the window, so the dialog there is unchanged.
  const scrim = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    document.body.classList.add("vv-sheet");
    const fit = () => {
      if (vv) {
        root.style.setProperty("--vvh", `${vv.height}px`);
        root.style.setProperty("--vvt", `${vv.offsetTop}px`);
      }
      // Pinning the footer only helps if the sheet scrolls a focused field out from under it, so nudge the field back up.
      const field = document.activeElement;
      const sheet = dialog.current;
      if (!sheet || !(field instanceof HTMLElement) || !sheet.contains(field) || field.closest(".actions")) return;
      // The pin line: the sheet's padding ends this far above its bottom edge (see body.vv-sheet .modal in app.css).
      const pin = sheet.getBoundingClientRect().bottom - parseFloat(getComputedStyle(sheet).paddingBottom || "0");
      if (field.getBoundingClientRect().bottom > pin) field.scrollIntoView({ block: "nearest" });
    };
    fit();
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    document.addEventListener("focusin", fit);
    return () => {
      document.body.classList.remove("vv-sheet");
      document.removeEventListener("focusin", fit);
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, []);
  return (
    <div className="scrim" ref={scrim} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${small ? " sm" : ""}`} role="dialog" aria-modal="true" aria-label={label} aria-describedby={describedBy} tabIndex={-1} ref={(el) => { ref.current = el; dialog.current = el; }} style={{ outline: "none" }}>
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

/** SHO-US-14.2: shown when a screen could not load because the server did not answer. Retry reloads without leaving the page. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="card empty" role="alert">
      <b>Could not reach the server.</b>
      <p className="hint" style={{ margin: "6px 0 12px" }}>Check your connection, then try again. Nothing was lost.</p>
      <button className="btn" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** SHO-US-14.2 AC1: after 400 ms of loading, grey rows in the shape of the final layout. Before that nothing flashes. */
export function Skeleton({ rows = 5, kind = "list" }: { rows?: number; kind?: "list" | "cards" }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 400); return () => clearTimeout(t); }, []);
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={`skel-wrap ${kind}`}>
      <span className="sr-only">Loading</span>
      {show && Array.from({ length: rows }, (_, i) => <div key={i} className="skel-row" aria-hidden="true" />)}
    </div>
  );
}
