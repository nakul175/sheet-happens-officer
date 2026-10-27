"use client";
import { useEffect, useRef, useState } from "react";
import { holySheetDocumentId } from "@/lib/holy-sheet-url";

export function HolySheetLauncher({ taskId }: { taskId: string }) {
  const [context, setContext] = useState<{origin: string; subject: string} | null>(null);
  const [visible, setVisible] = useState(false), [error, setError] = useState("");
  const [url, setUrl] = useState(""), [frame, setFrame] = useState("");
  const [generation, setGeneration] = useState(0);
  const verified = useRef<{origin: string; subject: string} | null>(null);
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    function lock() { setFrame(""); setContext(null); verified.current = null; }
    async function check() {
      const attempt = ++request;
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/holy-sheet`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (cancelled || attempt !== request) return;
        if (response.status === 404) { lock(); setVisible(false); return; }
        setVisible(true);
        if (!response.ok) { lock(); setError("Sign in with Aplyd and check your task access, then retry."); return; }
        const data = await response.json();
        if (cancelled || attempt !== request) return;
        if (data.origin !== "https://staging.holysheet.aplyd.org" || typeof data.subject !== "string" || !data.subject) throw new Error();
        if (verified.current && verified.current.subject !== data.subject) setFrame("");
        verified.current = data; setContext(data); setError("");
      } catch { if (!cancelled && attempt === request) { lock(); setVisible(true); setError("Holy Sheet access could not be checked. Try again."); } }
    }
    void check();
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(onFocus, 60000);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [taskId, generation]);
  if (!visible) return null;
  return <section aria-label="Holy Sheet" style={{marginTop: 24}}>
    <h3>Holy Sheet</h3>
    <p className="sub">Open a document here. Its Holy Sheet permissions still apply.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const id = context && holySheetDocumentId(url.trim(), context.origin);
      if (!id || !context) { setError("Enter a page URL from Holy Sheet staging."); return; }
      setError(""); setFrame(`${context.origin}/embed/pages/${id}#hs-user=${encodeURIComponent(context.subject)}`);
    }}>
      <label>Document URL <input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label>
      <button className="btn" disabled={!context}>Open document</button>
      <button className="btn ghost" type="button" onClick={() => setGeneration(n => n + 1)}>Check access again</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {frame && <><a href={frame.replace('/embed/pages/', '/pages/').split('#')[0]} target="_blank" rel="noopener noreferrer">Open in Holy Sheet</a>
      <iframe title="Holy Sheet document" src={frame} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        style={{width: "100%", height: "70vh", border: "1px solid var(--border)", marginTop: 12}} /></>}
  </section>;
}
