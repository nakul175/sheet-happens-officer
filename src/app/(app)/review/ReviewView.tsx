"use client";
import Link from "next/link";
import { Skeleton, LoadFailed } from "@/components/ui";
import { useState } from "react";
import { api, dueLabel, useGet } from "@/components/api";
import { ConvertDialog } from "@/components/ConvertDialog";
import { reviewQueue, type ReviewData, type ReviewCategory, type Idea } from "@/lib/review-queue";
import { Page, useMe } from "../Shell";
import "./review.css";
const categories: [ReviewCategory, string][] = [["all", "All"], ["missing", "Missing next step"], ["overdue", "Overdue"], ["inactive", "Inactive"], ["ideas", "Ideas"]];
const reasonLabels = { missing: "Next step missing", overdue: "Next step overdue", inactive: "Inactive 30+ days", ideas: "Idea · 30+ days" };
export default function ReviewView() {
  const me = useMe();
  const { data, loading, error, reload } = useGet<ReviewData>("/api/review?timeline=all");
  const [category, setCategory] = useState<ReviewCategory>("all");
  const [conv, setConv] = useState<Idea | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const queue = data ? reviewQueue(data) : null;
  const rows = queue?.rows.filter(r => category === "all" || r.reasons.includes(category)) ?? [];
  async function drop(t: Idea) {
    if (busy) return; setBusy(t.id); setActionError(null);
    const r = await api("POST", `/api/tasks/${t.id}/idea`, { isIdea: false }); setBusy(null);
    if (r.ok) reload(); else setActionError(r.error ?? "Could not drop the idea.");
  }
  return <Page className="review-view" title="Review" sub="Keep opportunities moving." actions={<Link className="btn ghost" href="/review/reporting">Open reporting ↗</Link>}>
    {loading && !data && <Skeleton />}
    {error && <LoadFailed onRetry={reload} />}
    {actionError && <div className="err" role="alert">{actionError}</div>}
    {queue && <>
      <div className="review-categories" role="group" aria-label="Review categories">{categories.map(([key, label]) => <button key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{label} <span>{queue.counts[key]}</span></button>)}</div>
      <section className="review-panel" aria-label="Review queue">
        <div className="review-table-wrap"><table className="tbl stack review-table"><thead><tr><th>Opportunity</th><th>Needs attention</th><th>Context</th><th>Action</th></tr></thead><tbody>
          {rows.map(r => <tr key={r.key}>
            <td data-label="Opportunity"><div className="review-cell-copy"><strong>{r.name}</strong><small>{r.deal?.organisation?.name ?? r.idea?.project.name}</small></div></td>
            <td data-label="Needs attention"><div className="review-cell-copy">{r.reasons.map(reason => <span className={reason === "overdue" ? "review-overdue" : "review-reason"} key={reason}>{reasonLabels[reason]}</span>)}</div></td>
            <td data-label="Context"><div className="review-cell-copy">{r.deal ? <>
              {r.deal.nextStep ? <span>{r.deal.nextStep.title} · {dueLabel(r.deal.nextStep.dueDate)}</span> : r.deal.lastActivity ? <span>Last active {dueLabel(r.deal.lastActivity.slice(0, 10))}</span> : <span>{r.deal.stage ?? "No next step"}</span>}
              <details><summary>More context</summary><p>{[r.deal.pipeline, r.deal.stage, r.deal.leader?.name].filter(Boolean).join(" · ")}</p>{r.deal.lastActivity && <p>Last activity {dueLabel(r.deal.lastActivity.slice(0, 10))}</p>}</details>
            </> : <>{r.idea!.assignee.name}<small>Added {dueLabel(r.idea!.createdAt.slice(0, 10))}</small></>}</div></td>
            <td data-label="Action"><div className="review-actions"><Link href={r.deal ? `/projects/${r.deal.id}` : `/projects/${r.idea!.project.id}?task=${r.idea!.id}`}>Open</Link>{r.idea?.canEdit && <><button className="btn ghost sm" aria-label="Convert to deal" onClick={() => setConv(r.idea!)}>Convert</button><button className="link" disabled={!!busy} onClick={() => drop(r.idea!)}>Drop</button></>}</div></td>
          </tr>)}
        </tbody></table></div>
        {!rows.length && <p className="review-empty">{queue.rows.length ? "No items in this category." : "Nothing needs attention."}</p>}
        <p className="hint" role="status">{rows.length} item{rows.length === 1 ? "" : "s"} need{rows.length === 1 ? "s" : ""} attention</p>
      </section>
    </>}
    {conv && <ConvertDialog task={{ id: conv.id, title: conv.title, dueDate: conv.dueDate, assignee: conv.assignee }} meId={me.id} onClose={() => setConv(null)} />}
  </Page>;
}
