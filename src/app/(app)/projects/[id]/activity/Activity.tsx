"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ago, api, useGet } from "@/components/api";
import { requestUndo } from "@/components/UndoHost";
import { LoadFailed, Skeleton } from "@/components/ui";
import { showTooOld, showUndo, type ActivityRow } from "@/lib/activity-row";
import { Page } from "../../../Shell";

// SHO-2701: the row decisions live in src/lib/activity-row.ts and branch on the row's `kind`, not on `what`.
// Re-exported so the screen's own surface is unchanged.
export { isDeletedTaskRow, showTooOld, showUndo } from "@/lib/activity-row";

export default function Activity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const a = useGet<{ items: ActivityRow[]; nextCursor: string | null }>(`/api/projects/${id}/activity`);
  const pr = useGet<{ project: { role: string } }>(`/api/projects/${id}`);
  const [more, setMore] = useState<ActivityRow[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const { reload } = a;
  useEffect(() => {
    // After an Undo, refresh this list instead of reloading the page.
    const done = (e: Event) => { e.preventDefault(); setMore([]); setCursor(undefined); reload(); };
    window.addEventListener("sho:undone", done);
    return () => window.removeEventListener("sho:undone", done);
  }, [reload]);
  if (!a.data && a.failed) return <Page title="Activity"><LoadFailed onRetry={a.reload} /></Page>;
  if (a.status === 403 || a.status === 404) {
    return <Page title="Activity"><div className="card empty">{a.status === 403 ? "Only people who work on this project can see Activity." : "This project isn't available."}<br /><Link href={`/projects/${id}`}>Back to the project</Link></div></Page>;
  }
  const next = cursor === undefined ? a.data?.nextCursor : cursor;
  const rows = [...(a.data?.items ?? []), ...more];
  return (
    <Page title="Activity" sub={<Link href={`/projects/${id}`}>← Project</Link>}>
      {a.loading && !a.data && <Skeleton />}
      {a.data && !rows.length && <div className="card empty">Nothing has happened yet.</div>}
      {!!rows.length && (
        <div className="list actlist" role="list" aria-label="Activity">
          {rows.map((r) => (
            <div className="item act" role="listitem" key={r.id}>
              <div className="t">
                <span className="act-s"><strong>{r.who}</strong> {r.what}</span>
                <small title={r.when}>{ago(new Date(r.ts).toISOString())} · {r.when}</small>
              </div>
              <div className="meta">
                {r.via === "concierge" && <span className="chip gold">via concierge</span>}
                {showUndo(r, pr.data?.project.role) && <button className="btn ghost sm" onClick={() => requestUndo(r.id)}>Undo</button>}
                {showTooOld(r, pr.data?.project.role) && <span className="hint" title="Undo works for 30 days">Too old to undo</span>}
                {r.undo === "undone" && <span className="hint">Undone</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {next && <p><button className="btn ghost" onClick={async () => { const r = await api<{ items: ActivityRow[]; nextCursor: string | null }>("GET", `/api/projects/${id}/activity?cursor=${next}`); if (r.ok) { setMore((m) => [...m, ...r.data.items]); setCursor(r.data.nextCursor); } }}>Load more</button></p>}
    </Page>
  );
}
