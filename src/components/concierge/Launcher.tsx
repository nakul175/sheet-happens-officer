"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "./Concierge";
import { useConcierge } from "./ConciergeProvider";

const EVENT = "sho:concierge";
/** Ask the shell to bring the concierge up: show it if hidden, then focus its input (or open the sheet where there is no panel). */
export const openConcierge = () => window.dispatchEvent(new Event(EVENT));

const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null;

/**
 * SHO-US-14.15 AC1. One entry in the sidebar (and the phone More menu) that reaches the concierge from any screen:
 * on a wide screen it focuses the panel's input, otherwise it opens the full-screen sheet.
 */
export function ConciergeHost() {
  const c = useConcierge();
  const [sheet, setSheet] = useState(false);
  const from = useRef<HTMLElement | null>(null);
  const hidden = c?.hidden ?? false;
  const setHidden = c?.setHidden;
  const pending = useRef(false);

  const reveal = useCallback(() => {
    const slot = [...document.querySelectorAll(".cc-slot, .cc-barslot")].find(visible);
    if (slot) { // the panel is already on screen: put the cursor in it (paused: on its first chip)
      (slot.querySelector<HTMLElement>("textarea:not([disabled])") ?? slot.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
      return;
    }
    setSheet(true);
  }, []);

  useEffect(() => {
    const on = () => {
      from.current = document.activeElement as HTMLElement | null;
      if (hidden) { pending.current = true; void setHidden?.(false); return; }
      setTimeout(reveal, 80); // after a closing drawer has handed focus back
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [hidden, setHidden, reveal]);

  // After "Show", wait for the panel to mount, then focus it.
  useEffect(() => {
    if (hidden || !pending.current) return;
    pending.current = false;
    const t = setTimeout(reveal, 60);
    return () => clearTimeout(t);
  }, [hidden, reveal]);

  useEffect(() => {
    if (!sheet) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[aria-modal='true']")) close(); };
    document.addEventListener("keydown", esc);
    document.querySelector<HTMLTextAreaElement>(".cc-host textarea")?.focus();
    const vv = window.visualViewport;
    const fit = () => {
      if (!vv) return;
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
      document.documentElement.style.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    fit();
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    return () => {
      document.removeEventListener("keydown", esc);
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      document.documentElement.style.removeProperty("--vvh");
      document.documentElement.style.removeProperty("--vvt");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  function close() { setSheet(false); setTimeout(() => from.current?.focus?.(), 0); }
  if (!c || !sheet) return null;
  return <div className="cc-sheet cc-host" role="dialog" aria-label="Concierge"><Panel variant="sheet" onClose={close} /></div>;
}

/** Sidebar entry. Styled like the other nav links. */
export function ConciergeNavItem({ onPick }: { onPick?: () => void }) {
  const c = useConcierge();
  if (!c) return null;
  return <button className="navbtn" onClick={() => { onPick?.(); openConcierge(); }}>Concierge{c.hidden && <small> (hidden)</small>}</button>;
}
