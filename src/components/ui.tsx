"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** An open dialog: its identity for this render tree and the element a keypress has to belong to. */
type Open = { me: symbol; el: HTMLElement | null };

/**
 * SHO-3025: the dialogs that are open. Only the one on top answers Escape, and it stops the event there.
 * Before this, every open dialog put its own listener on `document`, so in a task sheet with a confirm over it a
 * single Escape closed both - and any other Escape listener on the page (a drawer, a menu) acted on it too.
 */
const OPEN: Open[] = [];

/**
 * The dialog a keypress belongs to: the last one opened, unless a dialog is rendered inside another - then the
 * inner one is on top. Two dialogs opened together in one commit are therefore ordered by the tree, not by
 * whichever layout effect happened to run first.
 */
function topDialog(): HTMLElement | null {
  const els = OPEN.map((o) => o.el).filter((el): el is HTMLElement => !!el);
  for (let i = OPEN.length - 1; i >= 0; i--) {
    const el = OPEN[i].el;
    if (el && !els.some((other) => other !== el && el.contains(other))) return el;
  }
  return null;
}

/**
 * SHO-3025: the key listener, the scroll lock and the focus move belong to the commit that paints the dialog, not
 * to an effect React runs after the paint. Keyed to the commit, a dialog is never on screen without answering
 * Escape. (A layout effect does nothing on the server, where the dialog is not on screen either.)
 */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Centred dialog over a dimmed page. Escape and the dim area close it; focus moves in and returns. */
export function Modal({ onClose, small, label, describedBy, children }: { onClose: () => void; small?: boolean; label: string; describedBy?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The handler to call now. A re-render of the parent gives a new one; the key listener reads it from here, so it
  // is never torn down and added again (a gap a keypress could fall into, or one that holds a stale handler).
  const latest = useRef(onClose);
  useCommitEffect(() => { latest.current = onClose; });
  useCommitEffect(() => {
    const me = Symbol("dialog");
    const dialog = ref.current;
    OPEN.push({ me, el: dialog });
    const prev = document.activeElement as HTMLElement | null;
    if (topDialog() === dialog) (dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? dialog)?.focus(); // SHO-US-14.5: a dialog can name the field that gets focus
    // SHO-US-22.7: the page behind a dialog must not scroll.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keys = (e: KeyboardEvent) => {
      // Capture phase: Escape belongs to the dialog on top. A drawer or menu that was already open behind it
      // registered its own listener first, so it would otherwise take the key before the dialog did; the event
      // stops here so nothing else acts on the same press.
      if (e.key === "Escape") {
        if (topDialog() !== dialog) return; // the dialog opened over this one owns Escape
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return; // a held key is one close request, not one per repeat
        latest.current();
        return;
      }
      // SHO-US-14.3: keep Tab inside the dialog on top.
      if (e.key !== "Tab" || !dialog || topDialog() !== dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (e.shiftKey && (at === first || at === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      else if (!dialog.contains(at)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keys, true);
    return () => {
      document.removeEventListener("keydown", keys, true);
      const at = OPEN.findIndex((o) => o.me === me);
      if (at !== -1) OPEN.splice(at, 1);
      document.body.style.overflow = before;
      if (prev?.isConnected) prev.focus();
    };
  }, []);
  // SHO-2738: on a phone the keyboard shortens the visible area, not the page, so the sheet is sized from visualViewport
  // (--vvh/--vvt, the same pair the Concierge sheet uses) and the footer is pinned to the bottom of that area.
  // On a desktop visualViewport is the window, so the dialog there is unchanged.
  const scrim = useRef<HTMLDivElement>(null);
  // SHO-3025 keeps its own `dialog` element local to the key effect above; this ref is the sheet the viewport fit works on.
  const sheetRef = useRef<HTMLDivElement>(null);
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
      const sheet = sheetRef.current;
      if (!sheet || !(field instanceof HTMLElement) || !sheet.contains(field) || field === sheet || field.closest(".bar, .actions")) return;
      // Scroll this sheet explicitly: scrollIntoView can use the layout viewport while the keyboard is resizing
      // the visual viewport, leaving the focused field below the pinned footer even though the sheet fits.
      const bounds = sheet.getBoundingClientRect();
      const footer = sheet.querySelector<HTMLElement>(".actions")?.getBoundingClientRect();
      const header = sheet.querySelector<HTMLElement>(".bar")?.getBoundingClientRect();
      const bottom = Math.min(bounds.bottom, footer && footer.top > bounds.top ? footer.top : bounds.bottom) - 8;
      const top = Math.max(bounds.top, header?.bottom ?? bounds.top) + 8;
      const box = field.getBoundingClientRect();
      if (box.bottom > bottom) sheet.scrollTop += box.bottom - bottom;
      else if (box.top < top) sheet.scrollTop -= top - box.top;
    };
    let frame = 0;
    const scheduleFit = () => {
      fit();
      cancelAnimationFrame(frame);
      // Focus scrolling and viewport layout can finish after the event. Reconcile once after that layout too.
      frame = requestAnimationFrame(() => { fit(); frame = requestAnimationFrame(fit); });
    };
    scheduleFit();
    vv?.addEventListener("resize", scheduleFit);
    vv?.addEventListener("scroll", scheduleFit);
    document.addEventListener("focusin", scheduleFit);
    return () => {
      document.body.classList.remove("vv-sheet");
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", scheduleFit);
      vv?.removeEventListener("resize", scheduleFit);
      vv?.removeEventListener("scroll", scheduleFit);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, []);
  return (
    <div className="scrim" ref={scrim} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${small ? " sm" : ""}`} role="dialog" aria-modal="true" aria-label={label} aria-describedby={describedBy} tabIndex={-1} ref={(el) => { ref.current = el; sheetRef.current = el; }} style={{ outline: "none" }}>
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
