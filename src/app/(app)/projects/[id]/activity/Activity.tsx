"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ago, api, isNetworkFailure, useGet } from "@/components/api";
import { requestUndo } from "@/components/UndoHost";
import { LoadFailed } from "@/components/ui";
import { Page } from "../../../Shell";

type Row = { id: string; at: string; who: string; via: string; what: string; change: string | null; undo: "available" | "undone" | "too_old" | "none" };

export default function Activity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const a = useGet<{ items: Row[]; nextCursor: string | null }>(`/api/projects/${id}/activity`);
  const [more, setMore] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const { reload } = a;
  useEffect(() => {
    // After an Undo, refresh this list instead of reloading the page.
    const done = (e: Event) => { e.preventDefault(); setMore([]); setCursor(undefined); reload(); };
    window.addEventListener("sho:undone", done);
    return () => window.removeEventListener("sho:undone", done);
  }, [reload]);
  if (!a.data && isNetworkFailure(a.status)) return <Page title="Activity"><LoadFailed onRetry={a.reload} /></Page>;
  if (a.status === 403 || a.status === 404) {
    return <Page title="Activity"><div className="card empty">{a.status === 403 ? "Only the project Leader and Admins can see Activity." : "This project isn't available."}<br /><Link href={`/projects/${id}`}>Back to the project</Link></div></Page>;
  }
  const next = cursor === undefined ? a.data?.nextCursor : cursor;
  const rows = [...(a.data?.items ?? []), ...more];
  return (
    <Page title="Activity" sub={<Link href={`/projects/${id}`}>← Project</Link>}>
      {a.data && !rows.length && <div className="card empty">Nothing has happened yet.</div>}
      {!!rows.length && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>How</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td title={new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>{ago(r.at)}</td>
                  <td>{r.who}</td>
                  <td>{r.what}{r.change && <div className="hint">{r.change}</div>}</td>
                  <td>{r.via === "concierge" ? <span className="chip gold">via concierge</span> : "on screen"}</td>
                  <td>
                    {r.undo === "available" && <button className="btn ghost sm" onClick={() => requestUndo(r.id)}>Undo</button>}
                    {r.undo === "too_old" && <span className="hint" title="Undo works for 30 days">Too old to undo</span>}
                    {r.undo === "undone" && <span className="hint">Undone</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <p><button className="btn ghost" onClick={async () => { const r = await api<{ items: Row[]; nextCursor: string | null }>("GET", `/api/projects/${id}/activity?cursor=${next}`); if (r.ok) { setMore((m) => [...m, ...r.data.items]); setCursor(r.data.nextCursor); } }}>Load more</button></p>}
    </Page>
  );
}
