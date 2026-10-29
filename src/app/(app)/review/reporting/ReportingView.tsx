"use client";
import Link from "next/link";
import { useState, type KeyboardEvent } from "react";
import { useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import type { Counts, ReviewData } from "@/lib/review-queue";
import { Page } from "../../Shell";
import "../review.css";
const categories = [["commercial", "Commercial"], ["other", "Other opportunities"], ["unclassified", "Unclassified"]] as const;
type Category = (typeof categories)[number][0];
const labels = { commercial: "Commercial pipeline by stage · RFP/RFA + OTC", other: "Other opportunities by stage · EOI + CV/LTA", unclassified: "Unclassified opportunities by stage · not included in commercial/other totals" };
export function flattenCounts(counts: Counts) {
  return counts.flatMap(p => p.stages.length ? p.stages.map(s => ({ ...s, pipelineId: p.id, pipeline: p.name })) : [{ id: "empty", name: "No stages", count: 0, sums: [], withoutValue: 0, pipelineId: p.id, pipeline: p.name }]);
}
export default function ReportingView() {
  const [category, setCategory] = useState<Category>("commercial");
  const [timeline, setTimeline] = useState("all");
  const { data, loading, error, reload } = useGet<ReviewData>(`/api/review?timeline=${timeline}`);
  const counts = data ? category === "commercial" ? data.counts : category === "other" ? data.otherCounts ?? [] : data.unclassifiedCounts ?? [] : [];
  const rows = flattenCounts(counts);
  const missing = rows.reduce((sum, s) => sum + s.withoutValue, 0);
  function tabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = e.key === "ArrowRight" ? (index + 1) % 3 : e.key === "ArrowLeft" ? (index + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : null;
    if (next === null) return; e.preventDefault(); setCategory(categories[next][0]); e.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
  }
  return <Page className="review-view reporting-view" title="Reporting" sub="Opportunity counts and value by stage." beforeTitle={<nav className="review-breadcrumb" aria-label="Breadcrumb"><Link href="/review">Review</Link> / Reporting</nav>} actions={<Link className="btn ghost" href="/review">← Back to review</Link>}>
    <div className="reporting-controls"><div className="reporting-tabs" role="tablist" aria-label="Reporting category">{categories.map(([key, name], index) => <button key={key} id={`report-${key}`} role="tab" aria-selected={category === key} aria-controls="report-panel" tabIndex={category === key ? 0 : -1} onKeyDown={e => tabKey(e, index)} onClick={() => setCategory(key)}>{name}</button>)}</div>
      <label>Timeline <select id="review-timeline" className="in" value={timeline} onChange={e => setTimeline(e.target.value)}><option value="all">All deadlines</option><option value="overdue">Overdue</option><option value="30d">Next 30 days</option><option value="90d">Next 90 days</option></select></label>
    </div>
    {loading && !data && <Skeleton />}
    {error && <LoadFailed onRetry={reload} />}
    {data && <>
      {category === "commercial" ? <p><strong>Open commercial · {data.openCommercialCount}</strong><br /><small>{data.headlineRule}</small></p> : <p className="hint">{category === "other" ? "EOI + CV/LTA, reported separately from commercial opportunities." : "Unclassified opportunities are excluded from commercial and other totals."}</p>}
      <div id="report-panel" role="tabpanel" aria-labelledby={`report-${category}`}><section className="review-panel" aria-label={labels[category]}><div className="review-table-wrap"><table className="tbl stack review-table"><thead><tr><th>Pipeline</th><th>Stage</th><th>Opportunities</th><th>Value by currency</th><th>Missing value</th></tr></thead><tbody>
        {rows.map(r => <tr key={`${r.pipelineId}:${r.id}`}><td data-label="Pipeline">{r.pipeline}</td><td data-label="Stage">{r.name}</td><td data-label="Opportunities">{r.count}</td><td data-label="Value by currency">{r.sums.length ? r.sums.map(s => `${s.currency} ${s.total.toLocaleString("en-IN")}`).join(" · ") : "—"}</td><td data-label="Missing value">{r.withoutValue}</td></tr>)}
      </tbody></table></div>
        {!rows.length && <p className="review-empty">No pipeline stages in this category.</p>}
        <p className="hint">{missing} opportunit{missing === 1 ? "y has" : "ies have"} no recorded value. Currency totals are shown separately.</p>
      </section></div>
      <p className="hint">Commercial: RFP/RFA + OTC. Other opportunities: EOI + CV/LTA. Unclassified opportunities are excluded from both totals.</p>
    </>}
  </Page>;
}
