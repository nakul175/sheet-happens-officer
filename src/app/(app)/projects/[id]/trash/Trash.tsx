"use client";
import Link from "next/link";
import { use, useState } from "react";
import { ago, api, useGet } from "@/components/api";
import { Confirm } from "@/components/ui";
import { Page } from "../../../Shell";

type Item = { id: string; title: string; isSubtask: boolean; deletedAt: string; deletedBy: { name: string } | null; daysLeft: number };

export default function Trash({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pr = useGet<{ project: { name: string; role: string; archived: boolean } }>(`/api/projects/${id}`);
  const tr = useGet<{ items: Item[] }>(`/api/projects/${id}/trash`);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { item: Item; parent: string }>(null);
  const p = pr.data?.project;
  if (tr.error && !tr.data) return <Page title="This project isn't available"><div className="card empty"><Link href="/projects">Back to Projects</Link></div></Page>;
  const canRestore = !!p && p.role !== "VIEWER" && !p.archived;
  async function restore(item: Item, confirmParent = false) {
    const r = await api("POST", `/api/tasks/${item.id}/restore`, { confirmParent });
    if (r.ok) { setAsk(null); setErr(null); tr.reload(); }
    else if (r.status === 409 && r.data.needsConfirm === "parent") setAsk({ item, parent: r.data.parentTitle as string });
    else setErr(r.error ?? "Could not restore.");
  }
  return (
    <Page title="Trash" sub={<><Link href={`/projects/${id}`}>← {p?.name ?? "Project"}</Link> · Tasks are kept for 30 days, then removed for good.</>}>
      {err && <div className="err" role="alert">{err}</div>}
      {tr.data && !tr.data.items.length && <div className="card empty">Trash is empty.</div>}
      {!!tr.data?.items.length && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>Item</th><th>Deleted by</th><th>Deleted</th><th>Time left</th><th /></tr></thead>
            <tbody>
              {tr.data.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.title}{i.isSubtask && <> <span className="chip grey">Subtask</span></>}</td>
                  <td>{i.deletedBy?.name ?? "—"}</td>
                  <td>{ago(i.deletedAt)}</td>
                  <td>{i.daysLeft} day{i.daysLeft === 1 ? "" : "s"}</td>
                  <td>{canRestore && <button className="btn ghost sm" onClick={() => restore(i)}>Restore</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ask && <Confirm title="Restore with its parent?" yes="Restore both" onNo={() => setAsk(null)} body={`"${ask.item.title}" belongs to "${ask.parent}", which is also in Trash. Restore both?`} onYes={() => restore(ask.item, true)} />}
    </Page>
  );
}
