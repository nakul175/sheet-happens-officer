"use client";
import Link from "next/link";
import "./trash.css";
import { use, useState } from "react";
import { ago, api, useGet } from "@/components/api";
import { Confirm, LoadFailed, Skeleton } from "@/components/ui";
import { Page } from "../../../Shell";

type Item = { id: string; title: string; isSubtask: boolean; parentTitle?: string | null; deletedAt: string; deletedBy: { name: string } | null; daysLeft: number };

export default function Trash({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pr = useGet<{ project: { name: string; role: string; archived: boolean } }>(`/api/projects/${id}`);
  const tr = useGet<{ items: Item[] }>(`/api/projects/${id}/trash`);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { item: Item; parent: string }>(null);
  const p = pr.data?.project;
  if (!tr.data && (tr.failed || pr.failed)) return <Page className="project-trash-view" title="Trash"><LoadFailed onRetry={() => { tr.reload(); pr.reload(); }} /></Page>;
  if (tr.error && !tr.data) return <Page title="This project isn't available"><div className="card empty"><Link href="/projects">Back to Projects</Link></div></Page>;
  const canRestore = !!p && p.role === "LEADER" && !p.archived;
  async function restore(item: Item, confirmParent = false) {
    const r = await api("POST", `/api/tasks/${item.id}/restore`, { confirmParent });
    if (r.ok) { setAsk(null); setErr(null); tr.reload(); }
    else if (r.status === 409 && r.data.needsConfirm === "parent") setAsk({ item, parent: r.data.parentTitle as string });
    else setErr(r.error ?? "Could not restore.");
  }
  return (
    <Page className="project-trash-view" title="Trash" beforeTitle={<nav className="trash-breadcrumb" aria-label="Breadcrumb"><Link href="/projects">Projects</Link> / <Link href={`/projects/${id}`}>{p?.name ?? "Project"}</Link> / Trash</nav>} sub={`Deleted tasks from ${p?.name ?? "this project"}`} actions={<Link className="btn ghost" href={`/projects/${id}`}>Back to project</Link>}>
      <p className="trash-retention">Tasks are kept for 30 days, then permanently removed.</p>
      {p && !canRestore && <p className="box" role="note">{p.archived ? "This project is archived and read-only. Restore actions are unavailable while it is archived." : "Only the project Leader can restore deleted tasks. You can read these recoverable items."}</p>}
      {err && <div className="err" role="alert">{err}</div>}
      {tr.loading && !tr.data && <Skeleton />}
      <section className="trash-panel"><h2>Deleted items {tr.data && `(${tr.data.items.length})`}</h2>
      {tr.data && !tr.data.items.length && <div className="card empty">Trash is empty.</div>}
      {!!tr.data?.items.length && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>Item</th><th>Deleted by</th><th>Deleted</th><th>Time left</th><th><span className="sr">Restore</span></th></tr></thead>
            <tbody>
              {tr.data.items.map((i) => (
                <tr key={i.id}>
                  <td data-label="Item"><div className="trash-item-copy"><strong>{i.title}</strong>{i.isSubtask && <> <span className="trash-parent">Subtask{i.parentTitle ? ` of ${i.parentTitle}` : ""}</span></>}</div></td>
                  <td data-label="Deleted by">{i.deletedBy?.name ?? "—"}</td>
                  <td data-label="Deleted">{ago(i.deletedAt)}</td>
                  <td data-label="Time left">{i.daysLeft} day{i.daysLeft === 1 ? "" : "s"} left</td>
                  <td data-label="Restore">{canRestore && <button className="btn ghost sm" onClick={() => restore(i)}>Restore</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Restoring a subtask may also require restoring its parent.</p>
      </section>
      {ask && <Confirm title="Restore with its parent?" yes="Restore both" onNo={() => setAsk(null)} body={`The parent task "${ask.parent}" is also in Trash. Restore both "${ask.parent}" and "${ask.item.title}"?`} onYes={() => restore(ask.item, true)} />}
    </Page>
  );
}
