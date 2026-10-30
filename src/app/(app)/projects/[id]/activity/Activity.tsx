"use client";
import Link from "next/link";
import "./activity.css";
import { use, useEffect, useState } from "react";
import { ago, api, useGet, initials } from "@/components/api";
import { requestUndo } from "@/components/UndoHost";
import { LoadFailed, Skeleton } from "@/components/ui";
import { Page } from "../../../Shell";

type Row = { id: string; ts: number; when: string; who: string; via: string; kind: string; what: string; undo: "available" | "undone" | "too_old" | "none" };

/** SHO-2701: wording is presentation; the stored event kind determines delete controls. */
export function isDeletedTaskRow(kind: string) {
  return kind === "task.deleted";
}

/**
 * Undo on a delete follows Trash restore: only a Leader or an Admin (the project API reports both as LEADER).
 * Every other row keeps the feed's own undo flag. Hide the delete button until the role is known.
 */
export function showUndo(row: Pick<Row, "undo" | "kind">, role: string | undefined) {
  if (row.undo !== "available") return false;
  if (isDeletedTaskRow(row.kind) && role !== "LEADER") return false;
  return true;
}

/** AC6 v2.4: on a deleted-task row past the window, only whoever may restore (a Leader or Admin) sees "Too old to undo". */
export function showTooOld(row: Pick<Row, "undo" | "kind">, role: string | undefined) {
  return row.undo === "too_old" && (!isDeletedTaskRow(row.kind) || role === "LEADER");
}

export default function Activity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const a = useGet<{ items: Row[]; nextCursor: string | null }>(`/api/projects/${id}/activity`);
  const pr = useGet<{ project: { role: string; name?: string } }>(`/api/projects/${id}`);
  const [more, setMore] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const { reload } = a;
  useEffect(() => {
    // After an Undo, refresh this list instead of reloading the page.
    const done = (e: Event) => { e.preventDefault(); setMore([]); setCursor(undefined); reload(); };
    window.addEventListener("sho:undone", done);
    return () => window.removeEventListener("sho:undone", done);
  }, [reload]);
  if (!a.data && a.failed) return <Page className="project-activity-view" title="Activity"><LoadFailed onRetry={a.reload} /></Page>;
  if (a.status === 403 || a.status === 404) {
    return <Page className="project-activity-view" title="Activity"><div className="card empty">{a.status === 403 ? "Only people who work on this project can see Activity." : "This project isn't available."}<br /><Link href={`/projects/${id}`}>Back to the project</Link></div></Page>;
  }
  const next = cursor === undefined ? a.data?.nextCursor : cursor;
  const rows = [...(a.data?.items ?? []), ...more];
  return (
    <Page className="project-activity-view" title="Activity" beforeTitle={<nav className="activity-breadcrumb" aria-label="Breadcrumb"><Link href="/projects">Projects</Link> / <Link href={`/projects/${id}`}>{pr.data?.project.name ?? "Project"}</Link> / Activity</nav>} sub={`Recent changes in ${pr.data?.project.name ?? "this project"}`} actions={<Link className="btn ghost" href={`/projects/${id}`}>Back to project</Link>}>
      {a.loading && !a.data && <Skeleton />}
      <section className="activity-panel"><h2>Project activity</h2>
      {a.data && !rows.length && <div className="card empty">Nothing has happened yet.</div>}
      {!!rows.length && (
        <div className="list actlist" role="list" aria-label="Activity">
          {rows.map((r) => (
            <div className="item act" role="listitem" key={r.id}>
              <span className="activity-avatar" aria-hidden="true">{initials(r.who)}</span>
              <div className="t">
                <span className="act-s"><strong>{r.who}</strong> {r.what}</span>
                <small title={r.when}>{ago(new Date(r.ts).toISOString())} · {r.when}</small>
              </div>
              <div className="meta">
                {showUndo(r, pr.data?.project.role) && <button className="btn ghost sm" onClick={() => requestUndo(r.id)}>Undo</button>}
                {showTooOld(r, pr.data?.project.role) && <span className="hint" title="Undo works for 30 days">Too old to undo</span>}
                {r.undo === "undone" && <span className="hint">Undone</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {next && <p><button className="btn ghost" onClick={async () => { const r = await api<{ items: Row[]; nextCursor: string | null }>("GET", `/api/projects/${id}/activity?cursor=${next}`); if (r.ok) { setMore((m) => [...m, ...r.data.items]); setCursor(r.data.nextCursor); } }}>Load more</button></p>}
      </section>
    </Page>
  );
}
