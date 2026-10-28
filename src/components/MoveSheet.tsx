"use client";
import { useEffect, useRef } from "react";
import { useOverlayBack } from "@/components/use-overlay-back";

export type MoveOption = { id: string; name: string; current: boolean };

/** SHO-US-22.6: bottom sheet that lists the sections a task can move to. Rows are 44 px; Escape or the dim area closes it; focus returns to the button. */
export function MoveSheet({ title, options, onPick, onClose }: { title: string; options: MoveOption[]; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useOverlayBack(true, onClose, () => ref.current);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("keydown", keys); document.body.style.overflow = before; prev?.focus?.(); };
  }, [close]);
  return (
    <div className="msheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="msheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="msheet-head"><strong>{title}</strong><button className="link" onClick={() => close()}>Cancel</button></div>
        <ul>
          {options.map((o) => (
            <li key={o.id}>
              <button className="msheet-row" aria-current={o.current ? "true" : undefined} disabled={o.current} onClick={() => close(() => onPick(o.id))}>
                <span>{o.name}</span>{o.current && <small>Current</small>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
