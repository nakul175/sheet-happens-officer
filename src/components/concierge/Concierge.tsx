"use client";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Confirm } from "@/components/ui";
import { Composer } from "./Composer";
import { useConcierge } from "./ConciergeProvider";
import { resumeText } from "./logic";
import { MessageView } from "./MessageView";
import { PRIVACY_SENTENCE, type QuickActionId } from "./types";
import "./phone.css";

type Variant = "dock" | "bar" | "sheet";

/** SHO-US-14.15 AC3: paused is one line that says why and when it returns. Nothing else is disabled beside it. */
export const isPaused = (c: { loaded: boolean; loadError: string | null; available: boolean; disabled?: unknown }) => c.loaded && !c.loadError && (!c.available || !!c.disabled);
function DisabledNotice() {
  const c = useConcierge()!;
  if (!isPaused(c)) return null;
  const d = c.disabled;
  const when = d ? resumeText(d) : null;
  const msg = d?.message ?? "The concierge is not available for you right now.";
  return (
    <div className="cc-disabled" role="status">
      {msg}{when && !msg.includes("resume") && !msg.includes("resets") && <> It returns on {when}.</>}
    </div>
  );
}

function Thread({ variant }: { variant: Variant }) {
  const c = useConcierge()!;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [c.messages.length, c.busy, variant]);
  return (
    <div className="cc-thread" role="log" aria-label="Conversation" aria-live="polite">
      {c.loaded && !c.loadError && !isPaused(c) && c.messages.length === 0 && <p className="cc-empty">Ask about your tasks, or tell me what to change. Nothing changes until you tap Confirm.</p>}
      <ul>{c.messages.map((m) => <MessageView key={m.id} m={m} />)}</ul>
      {c.busy && <p className="cc-thinking" role="status">Working on it…</p>}
      <div ref={end} />
    </div>
  );
}

/** Chips follow the screen: on a project they are about that project (SHO-US-14.15 AC2). */
function Quick({ off, onUsed }: { off: boolean; onUsed?: () => void }) {
  const c = useConcierge()!;
  const path = usePathname();
  const project = /^\/projects\/([^/]+)/.exec(path)?.[1];
  const here = project && project !== "new" ? project : null;
  const chips: { key: string; id: QuickActionId; label: string; projectId?: string }[] = here
    ? [
        { key: "o", id: "overdue", label: "Show overdue here", projectId: here },
        { key: "d", id: "due-week", label: "Due this week here", projectId: here },
        { key: "b", id: "blocked", label: "Blocked here", projectId: here },
      ]
    : c.quickActions.map((q) => ({ key: q.id, id: q.id, label: q.label }));
  return (
    <div className="cc-quick" role="group" aria-label="Quick actions">
      {chips.map((q) => (
        <button key={q.key} className="cc-chip" disabled={off || c.busy} onClick={() => { c.quick(q.id, q.projectId); onUsed?.(); }}>{q.label}</button>
      ))}
    </div>
  );
}

export function Panel({ variant, onClose }: { variant: Variant; onClose?: () => void }) {
  const c = useConcierge()!;
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearErr, setClearErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(c.messages.length > 0); // bar variant only
  const paused = isPaused(c);
  const off = !c.loaded || !!c.loadError || paused; // composer
  // Quick actions are plain queries that need no model, so they keep working when a cap pauses the concierge.
  const quickOff = !c.loaded || !!c.loadError || c.disabled?.code === "NOT_ENABLED" || (!c.available && !c.disabled);
  const bar = variant === "bar";
  const count = c.messages.length;
  const [seen, setSeen] = useState(count);
  if (count !== seen) { setSeen(count); if (bar && count > seen) setExpanded(true); } // new message opens the bar's chat

  const head = (
    <header className="cc-head">
      <strong>Concierge</strong>
      <span className="grow" />
      {count > 0 && <button className="link" onClick={() => { setClearErr(null); setConfirmClear(true); }}>Clear my chat</button>}
      {!bar && <button className="link" onClick={() => c.setHidden(true)}>Hide</button>}
      {onClose && <button className="link" onClick={onClose}>Close</button>}
    </header>
  );
  const errBox = c.error && <div className="err cc-err" role="alert">{c.error} <button className="link" onClick={c.dismissError}>Dismiss</button></div>;
  const loadErr = c.loadError && <div className="err" role="alert">{c.loadError} <button className="link" onClick={c.retryLoad}>Try again</button></div>;

  return (
    <div className={`cc cc-${variant}`}>
      {bar ? (
        <>
          {expanded && (
            <div className="cc-barthread">
              {head}<DisabledNotice />{loadErr || <Thread variant={variant} />}
              {!c.loadError && <Quick off={quickOff} />}
              <p className="cc-privacy">{PRIVACY_SENTENCE}</p>
            </div>
          )}
          {!expanded && <DisabledNotice />}
          {errBox}
          <div className="cc-barrow">
            <strong>Concierge</strong>
            {!paused && <Composer off={off} compact />}
            <button className="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Open chat"}</button>
            <button className="link" onClick={() => c.setHidden(true)}>Hide</button>
          </div>
          {!expanded && <p className="sr">{PRIVACY_SENTENCE}</p>}
        </>
      ) : (
        <>
          {head}<DisabledNotice />{loadErr || <Thread variant={variant} />}
          {errBox}
          {!c.loadError && !(paused && c.disabled?.code === "NOT_ENABLED") && <Quick off={quickOff} />}
          {!paused && <Composer off={off} />}
          <p className="cc-privacy">{PRIVACY_SENTENCE}</p>
        </>
      )}
      {c.undoAsk && (
        <Confirm title="This changed since" yes="Undo anyway" danger
          body={`${c.undoAsk.changedBy.length ? c.undoAsk.changedBy.join(", ") + " changed " : "Something changed "}after this action. Undoing will overwrite: ${c.undoAsk.conflicts.map((x) => `${x.field} (now ${x.now})`).join("; ") || "later edits"}.`}
          onNo={c.dismissUndoAsk}
          onYes={() => c.undo(c.undoAsk!.cardId, true)} />
      )}
      {confirmClear && (
        <Confirm title="Clear my chat?" yes="Clear my chat" danger error={clearErr}
          body="This deletes your whole conversation with the concierge. Changes already made stay as they are."
          onNo={() => setConfirmClear(false)}
          onYes={async () => { const e = await c.clearChat(); if (e) setClearErr(e); else setConfirmClear(false); }} />
      )}
    </div>
  );
}

/** Small button that brings a hidden concierge back. Not used on its own any more: a floating pill covered content (SHO-US-14.15 AC4), so Show lives in the sidebar. */
export function ShowButton() {
  const c = useConcierge()!;
  return <button className="cc-show" onClick={() => c.setHidden(false)}>Show concierge</button>;
}

/** Right column on list screens (CSS shows it from 1280 px wide). */
export function ConciergeDock() {
  const c = useConcierge();
  if (!c) return null;
  if (c.hidden) return null;
  return <aside className="dock cc-slot" aria-label="Concierge"><Panel variant="dock" /></aside>;
}

/** Bottom bar on the board (CSS shows it from 881 px wide). */
export function ConciergeBar() {
  const c = useConcierge();
  if (!c) return null;
  if (c.hidden) return null;
  return <aside className="bardock cc-barslot" aria-label="Concierge"><Panel variant="bar" /></aside>;
}

/** Floating button that opens the concierge full screen on narrow screens. */
export function ConciergeFab({ kind }: { kind: "dock" | "bar" }) {
  const c = useConcierge();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pushed = useRef(false); // SHO-US-10.8: opening adds a history entry so the phone Back button closes the concierge instead of leaving the page
  const closeIt = useCallback(() => {
    if (pushed.current) { window.history.back(); return; } // the popstate handler closes it and returns focus
    setOpen(false); setTimeout(() => btn.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".scrim")) closeIt(); };
    const back = () => { if (pushed.current) { pushed.current = false; setOpen(false); setTimeout(() => btn.current?.focus(), 0); } };
    window.addEventListener("popstate", back);
    document.addEventListener("keydown", esc);
    document.querySelector<HTMLTextAreaElement>(".cc-sheet textarea")?.focus();
    // SHO-US-10.3: iOS Safari does not shrink the page when the keyboard opens, so follow the visible area.
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
      window.removeEventListener("popstate", back);
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      document.documentElement.style.removeProperty("--vvh");
      document.documentElement.style.removeProperty("--vvt");
    };
  }, [open, closeIt]);
  if (!c) return null;
  const close = closeIt;
  const toggle = () => {
    if (open) { close(); return; }
    try { window.history.pushState({ ...(window.history.state ?? {}), cc: 1 }, ""); pushed.current = true; } catch { /* no history: Close still works */ }
    setOpen(true);
  };
  if (c.hidden) return null; // SHO-US-14.15 AC4: no floating "Show" pill over rows; use Concierge in the menu
  return (
    <div className={`cc-fabwrap k-${kind}`}>
      <button ref={btn} className="fab" aria-label="Concierge" aria-expanded={open} onClick={toggle}>💬</button>
      {open && (
        <div className="cc-sheet" role="dialog" aria-label="Concierge">
          <Panel variant="sheet" onClose={close} />
        </div>
      )}
    </div>
  );
}
