"use client";
import { useEffect, useMemo, useState } from "react";
import { HolySheetEditor, type HostSessionProvider } from "@aplyd/holy-sheet-editor/hosted";
import { holySheetDocumentId, isApprovedHolySheetOrigin } from "@/lib/holy-sheet-url";

export function HolySheetLauncher({ taskId }: { taskId: string }) {
  const [visible, setVisible] = useState(false), [error, setError] = useState("");
  const [url, setUrl] = useState(""), [pageId, setPageId] = useState("");
  const provider = useMemo<HostSessionProvider>(() => ({async check({signal}) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/holy-sheet`, {cache: "no-store", signal});
    if (response.status === 401) return {status: "signin"};
    if (!response.ok) return {status: "unavailable"};
    const data = await response.json();
    if (!isApprovedHolySheetOrigin(data.origin) || typeof data.subject !== "string" || !data.subject) return {status: "unavailable"};
    return {status: "ready", origin: data.origin, subject: data.subject};
  }}), [taskId]);
  useEffect(() => {
    let cancelled = false;const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/holy-sheet`, {cache: "no-store", signal: controller.signal})
      .then(response => {if (!cancelled) setVisible(response.status !== 404);})
      .catch(() => {if (!cancelled) {setVisible(true);setError("Holy Sheet access could not be checked.");}})
      .finally(() => clearTimeout(timer));
    return () => {cancelled = true;clearTimeout(timer);controller.abort();};
  }, [taskId]);
  if (!visible) return null;
  return <section aria-label="Holy Sheet" style={{marginTop: 24}}>
    <h3>Holy Sheet</h3>
    <p className="sub">Open a document here. Its Holy Sheet permissions still apply.</p>
    <form onSubmit={event => {
      event.preventDefault();
      let candidateOrigin = "";
      try { candidateOrigin = new URL(url.trim()).origin; } catch { /* handled below */ }
      const id = isApprovedHolySheetOrigin(candidateOrigin) ? holySheetDocumentId(url.trim(), candidateOrigin) : null;
      if (!id) {setError("Enter a page URL from the approved Holy Sheet service.");return;}
      setError("");setPageId(id);
    }}>
      <label>Document URL <input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label>
      <button className="btn">Open document</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {pageId && <HolySheetEditor key={pageId} pageId={pageId} viewContext="embedded" sessionProvider={provider}/>}
  </section>;
}
