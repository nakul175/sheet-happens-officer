"use client";
import { useState } from "react";
import { api, useGet } from "@/components/api";
export default function CalendarFeed() {
  const status = useGet<{ issued: boolean }>("/api/profile/feed");
  const [url, setUrl] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <section className="card"><h2>Outlook calendar subscription</h2>
    <p>Read-only all-day tasks and deal submission deadlines, from 90 days ago through 365 days ahead. Titles and links only. No two-way sync, invitations or reminders.</p>
    <p>This private URL gives access to your calendar. Keep it secret. It is shown once and does not expire. Reset immediately disables the old URL; replace the subscription in Outlook afterwards.</p>
    {status.error && <p role="alert">{status.error}</p>}
    <button className="btn" disabled={busy || status.loading || !!status.error} onClick={async () => { setBusy(true); setUrl(""); const r = await api<{path: string}>("POST", "/api/profile/feed", {}); setBusy(false); if (r.ok) { setUrl(new URL(r.data.path, window.location.origin).href); setError(""); status.reload(); } else setError(r.error ?? "Could not issue URL."); }}>{status.data?.issued ? "Reset calendar URL" : "Create calendar URL"}</button>
    {error && <p role="alert">{error}</p>}
    {url && <label style={{display:"block",marginTop:12}}>Copy this URL now<input className="in" readOnly value={url} onFocus={e=>e.target.select()} /></label>}
    <h3>Outlook on the web</h3><ol><li>Open Outlook Calendar.</li><li>Select Add calendar, then Subscribe from web.</li><li>Paste the private URL above, choose a name and select Import.</li></ol>
    <h3>Outlook for Windows</h3><ol><li>In new Outlook, open Calendar → Add calendar → Subscribe from web.</li><li>Paste the private URL, give it a name and select Import.</li><li>In classic Outlook, use Calendar → Add Calendar → From Internet, paste the URL and confirm the subscription.</li></ol>
    <p>Subscribe from the web; downloading or importing an .ics file once will not keep it updated. Changes are available in this feed immediately, but Outlook refresh may take hours.</p>
  </section>;
}
