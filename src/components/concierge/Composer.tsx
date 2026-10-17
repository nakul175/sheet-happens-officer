"use client";
import { useEffect, useRef, useState } from "react";
import { useConcierge } from "./ConciergeProvider";
import { useDictation } from "./useDictation";

export function Composer({ off, compact }: { off: boolean; compact?: boolean }) {
  const c = useConcierge()!;
  const ta = useRef<HTMLTextAreaElement>(null);
  const [rewrite, setRewrite] = useState<{ original: string } | null>(null); // set while a rewrite is on offer
  const [notice, setNotice] = useState(false);
  const empty = !c.draft.trim();
  const dict = useDictation((t) => c.setDraft(c.draft.trim() ? `${c.draft.trim()} ${t}` : t));

  useEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } }, [c.draft]);

  async function send() {
    if (off || empty || c.busy) return;
    setRewrite(null);
    await c.send(c.draft);
    ta.current?.focus();
  }
  async function improve() {
    const original = c.draft;
    const better = await c.improve(original);
    if (better) { setRewrite({ original }); c.setDraft(better); }
  }
  function mic() {
    if (dict.listening) return;
    if (!c.voiceNoticeAcked) { setNotice(true); return; }
    dict.start();
  }

  const improveBtn = <button className="link" disabled={off || empty || c.busy || !!rewrite} onClick={improve}>Improve my prompt</button>;
  return (
    <div className="cc-composer">
      {notice && (
        <div className="cc-voice-notice" role="alertdialog" aria-label="About dictation">
          <p>When you dictate, your audio is processed by your browser&apos;s speech service, not by this app.</p>
          <button className="btn sm" autoFocus onClick={async () => { setNotice(false); await c.ackVoice(); dict.start(); }}>Got it</button>
        </div>
      )}
      {dict.listening && (
        <div className="cc-listening" role="status">
          <span className="cc-dot" aria-hidden="true" /> Listening…
          <button className="link" onClick={dict.stop}>Done</button>
          <button className="link" onClick={dict.cancel}>Cancel</button>
        </div>
      )}
      {dict.problem && <div className="err" role="alert">{dict.problem} <button className="link" onClick={dict.clearProblem}>Dismiss</button></div>}
      {rewrite && (
        <div className="cc-rewrite" role="group" aria-label="Suggested rewrite">
          <span>Here is a clearer version. Nothing has been sent.</span>
          <button className="btn sm" onClick={() => { setRewrite(null); ta.current?.focus(); }}>Use it</button>
          <button className="btn ghost sm" onClick={() => { c.setDraft(rewrite.original); setRewrite(null); ta.current?.focus(); }}>Keep mine</button>
        </div>
      )}
      <div className="cc-inrow">
        <textarea ref={ta} className="in cc-input" rows={compact ? 1 : 2} maxLength={2000} value={c.draft} disabled={off}
          aria-label="Message the concierge" placeholder={off ? "The concierge is not available right now" : "Ask or tell the concierge…"}
          onChange={(e) => c.setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        {dict.supported && (
          <button className="btn ghost sm cc-mic" aria-label="Dictate" title="Dictate" disabled={off || dict.listening} onClick={mic}>🎤</button>
        )}
        <button className="btn sm" disabled={off || empty || c.busy} onClick={send}>Send</button>
        {compact && improveBtn}
      </div>
      {!compact && <div className="cc-tools">{improveBtn}</div>}
    </div>
  );
}
