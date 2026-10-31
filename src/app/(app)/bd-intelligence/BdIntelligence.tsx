"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { useGet } from "@/components/api";
import { Skeleton } from "@/components/ui";
import { ATHENA_ROLES, OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { BD_PANELS, bdSnapshot, dealBuckets, isHppStage, isShortlistedStage, totalUsd, usd, type BdDeal, type BdPanel, type BdBucket, type UsdTotal } from "@/lib/bd-intelligence";
import { DEAL_DATE_FIELDS, type DealDateFilter } from "@/lib/deal-date-filter";
import { Page, useMe } from "../Shell";
import "./bd-intelligence.css";

function Money({ total }: { total: UsdTotal }) {
  return <><strong>{usd(total.cents)}</strong>{total.known < total.total && <small>{total.known} of {total.total} amounts known</small>}</>;
}
function Financial({ title, deals, color = "blue", unavailable = false }: { title: string; deals: BdDeal[]; color?: string; unavailable?: boolean }) {
  return <section className="bd-fin" aria-label={title}>
    <h3 className={`bd-color-${color}`}>{title}</h3>
    <dl><div><dt>Deals</dt><dd>{unavailable ? "NA" : deals.length}</dd></div>
      {([ ["Athena Budget", "budgetUsd", false], ["PWin-Adj Budget", "budgetUsd", true], ["NFR", "netFeeRevenueUsd", false], ["PWin-Adj NFR", "pwinAdjustedNfrUsd", false] ] as const).map(([label, field, weighted]) => <div key={label}><dt>{label}</dt><dd>{unavailable ? "NA" : <Money total={totalUsd(deals, field, weighted)} />}</dd></div>)}
    </dl>
  </section>;
}
function Pwin({ value }: { value: number | null | undefined }) {
  if (value == null) return <>NA</>;
  return <span className="bd-pwin"><meter min={0} max={100} value={value} aria-label="PWin" />{value}%</span>;
}
function DealTable({ title, deals }: { title: string; deals: BdDeal[] }) {
  return <section className="bd-table-section"><h2>{title} <span className="bd-count">{deals.length}</span></h2>
    {!deals.length ? <p className="bd-empty" role="status">No matching deals in this period.</p> : <div className="bd-table-scroll" tabIndex={0} role="region" aria-label={`${title} table; scroll for all columns`}>
      <table aria-label={title}><thead><tr>{["Opportunity", "Client", "Stage", "Partner", "Athena role", "Budget (USD)", "PWin-Adj Budget (USD)", "NFR (USD)", "PWin-Adj NFR (USD)", "PWin", "Type", "Geography", "Sector", "BM / Deal leader", "CBD POC", "Submission deadline"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{deals.map(d => <tr key={d.id}><th scope="row"><Link href={`/projects/${d.id}`}>{d.name}</Link></th><td>{d.organisation?.name ?? "NA"}</td><td><span className={`bd-badge bd-stage-${dealBuckets(d)[0] ?? "unknown"}`}>{d.stage?.name ?? "NA"}</span></td><td>{d.partner || "NA"}</td><td><span className={`bd-badge bd-role-${d.athenaRole?.toLowerCase() ?? "none"}`}>{ATHENA_ROLES.find(r => r.value === d.athenaRole)?.label ?? "NA"}</span></td><td>{usd(d.budgetUsd)}</td><td>{usd(totalUsd([d], "budgetUsd", true).cents)}</td><td>{usd(d.netFeeRevenueUsd)}</td><td>{usd(d.pwinAdjustedNfrUsd)}</td><td><Pwin value={d.probability} /></td><td>{OPPORTUNITY_TYPES.find(t => t.value === d.opportunityType)?.label ?? "NA"}</td><td>{d.organisation?.country || "NA"}</td><td>NA</td><td>{d.leader?.name ?? "NA"}</td><td>NA</td><td>{d.submissionDeadline ?? "NA"}</td></tr>)}</tbody>
      </table></div>}
  </section>;
}
export default function BdIntelligence() {
  const me = useMe(), id = useId();
  const [panel, setPanel] = useState<BdPanel>("summary");
  const [filter, setFilter] = useState<DealDateFilter>({ field: "stageChangedAt", start: "", end: "", undated: "include" });
  const result = useGet<{ deals: BdDeal[] }>(me.crm ? "/api/deals?lifecycle=all" : null);
  const catalog = useGet<{ pipelines: { stages: { name: string }[] }[] }>(me.crm ? "/api/deals/pipelines" : null);
  const invalid = !!(filter.start && filter.end && filter.start > filter.end);
  const snapshot = bdSnapshot(result.data?.deals ?? [], filter), buckets = snapshot.buckets;
  const stageNames = catalog.data?.pipelines.flatMap(p => p.stages.map(s => s.name)) ?? [];
  const knownStageNames = [...stageNames, ...(result.data?.deals.map(d => d.stage?.name ?? "") ?? [])];
  const hppKnown = knownStageNames.some(isHppStage), shortlistKnown = knownStageNames.some(isShortlistedStage);
  const unavailable = (key: string) => (key === "hpp" && !hppKnown) || (key === "shortlisted" && !shortlistKnown);
  const count = (key: BdBucket) => unavailable(key) ? "NA" : buckets[key].length;
  const tabs = BD_PANELS.map(([key, label]) => ({ key, label }));
  const choose = (index: number) => { const next = tabs[(index + tabs.length) % tabs.length].key; setPanel(next); document.getElementById(`${id}-tab-${next}`)?.focus(); };
  if (!me.crm) return <Page title="BD Intelligence Dashboard"><p role="status">This page is not available.</p></Page>;
  return <Page className="bd-dashboard" title="BD Intelligence Dashboard" sub="Live deals you are authorised to see" actions={<button className="btn" onClick={() => { result.reload(); catalog.reload(); }}>Refresh data</button>}>
    <header className="bd-brand"><div className="bd-brand-left"><span className="bd-logo" aria-hidden="true">A</span><div><strong>APLYD Practice · BD Intelligence</strong><span>Athena Infonomics · SSP check-in tracker</span></div></div><span className="bd-period">{filter.start || filter.end ? `${filter.start || "Any start"} – ${filter.end || "Any end"}` : "All dates"}</span></header>
    <div className="bd-filters" role="group" aria-label="Reporting period"><label>Period basis<select aria-label="Period basis" value={filter.field} onChange={e => setFilter({ ...filter, field: e.target.value as DealDateFilter["field"] })}>{DEAL_DATE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</select></label><label>From<input type="date" value={filter.start} onChange={e => setFilter({ ...filter, start: e.target.value })} /></label><label>To<input type="date" value={filter.end} onChange={e => setFilter({ ...filter, end: e.target.value })} /></label><label>Undated deals<select aria-label="Undated deals" value={filter.undated} onChange={e => setFilter({ ...filter, undated: e.target.value as DealDateFilter["undated"] })}><option value="include">Include</option><option value="exclude">Exclude</option><option value="only">Only undated</option></select></label><button className="btn" onClick={() => setFilter({ field: "stageChangedAt", start: "", end: "", undated: "include" })}>Clear period</button></div>
    <details className="bd-method"><summary>Current-stage snapshot · Reporting definitions</summary><p>Current-stage snapshot, filtered by the selected deal date, not historical stage transitions. Under Eval includes Submitted, Awaiting result, Shortlisted and explicitly named HPP stages. HPP/Shortlisted are NA until those stages are configured. Geography is buyer country; Sector, CBD POC, KMS and CNPS are NA where SHO has no source. PWin-Adj Budget = Budget × PWin; PWin-Adj NFR uses the entered USD value. Partial sums show their coverage.</p></details>
    {invalid ? <p role="alert">From must be on or before To.</p> : result.error || catalog.error ? <div className="bd-empty" role="alert"><p>Could not load BD data. No totals are shown.</p><button className="btn" onClick={() => { result.reload(); catalog.reload(); }}>Try again</button></div> : result.loading || catalog.loading || !result.data || !catalog.data ? <Skeleton /> : <>
      <div className="bd-tabs" role="tablist" aria-label="BD panels">{tabs.map(({ key, label }, index) => <button key={key} id={`${id}-tab-${key}`} role="tab" aria-selected={panel === key} aria-controls={`${id}-panel-${key}`} tabIndex={panel === key ? 0 : -1} onClick={() => setPanel(key)} onKeyDown={e => { if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) { e.preventDefault(); choose(e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : index + (e.key === "ArrowRight" ? 1 : -1)); } }}>{label}{key in buckets ? ` (${count(key as BdBucket)})` : ""}</button>)}</div>
      <div id={`${id}-panel-${panel}`} role="tabpanel" aria-labelledby={`${id}-tab-${panel}`} tabIndex={0} className="bd-panel">
        {panel === "summary" && <>
          <div className="bd-summary">{(["wip", "submissions", "eoicv", "evaluation", "hpp", "shortlisted", "wins", "losses"] as const).map((key, index) => <section key={key} className={`bd-stat bd-stat-${index % 4}`} aria-label={`${tabs.find(t => t.key === key)!.label} count`}><h2>{tabs.find(t => t.key === key)!.label}</h2><strong>{count(key)}</strong><small>{unavailable(key) ? "No matching stage configured" : "Current stage · selected period"}</small></section>)}</div>
          <h2>Financial Summary</h2><div className="bd-fin-grid"><Financial title="HPP Pipeline" deals={buckets.hpp} color="gold" unavailable={!hppKnown} /><Financial title="Under Evaluation" deals={buckets.evaluation} color="sky" /><Financial title="Wins" deals={buckets.wins} color="green" /><Financial title="Losses" deals={buckets.losses} color="red" /></div>
          <h2>Pipeline Snapshot</h2><div className="bd-fin-grid bd-two"><Financial title="Full Eval Pipeline" deals={buckets.evaluation} /><section className="bd-fin"><h3>Key KPIs</h3><dl><div><dt>HPP Athena Budget</dt><dd>{hppKnown ? <Money total={totalUsd(buckets.hpp, "budgetUsd")} /> : "NA"}</dd></div><div><dt>WIP proposals</dt><dd>{count("wip")}</dd></div><div><dt>Shortlisted</dt><dd>{count("shortlisted")}</dd></div><div><dt>CNPS rate (APLYD)</dt><dd>NA</dd></div><div><dt>CAS pending</dt><dd>NA</dd></div></dl></section></div>
          <h2>KMS & CNPS Summary</h2><p className="bd-empty">NA — KMS deliverables and CNPS responses are not recorded in SHO.</p>
        </>}
        {panel in buckets && <>{unavailable(panel) && <p role="status">NA — no {panel === "hpp" ? "HPP" : "Shortlisted"} stage is configured.</p>}<DealTable title={tabs.find(t => t.key === panel)!.label} deals={buckets[panel as BdBucket]} /></>}
        {panel === "snapshots" && <><h2>Pipeline snapshots</h2><div className="bd-fin-grid bd-two"><Financial title="Full Eval Pipeline" deals={buckets.evaluation} /><Financial title="HPP Pipeline" color="gold" deals={buckets.hpp} unavailable={!hppKnown} /></div><DealTable title="All current deals" deals={snapshot.selected} /></>}
        {panel === "kms" && <><h2>KMS & CNPS</h2><div className="bd-cnps"><strong>NA</strong><div><h3>APLYD CNPS rate</h3><p>No CNPS or KMS response source is connected to SHO.</p></div></div><div className="bd-fin-grid bd-two">{["KMS updates", "CNPS responses"].map(title => <section className="bd-fin" key={title}><h3>{title}</h3><p className="bd-empty">NA — no recorded source.</p></section>)}</div></>}
        {panel === "update" && <><h2>Add/Update BD Entry</h2><p>Create or open a Deal to edit Partner, Athena role, Budget (USD), PWin, NFR and PWin-adjusted NFR (USD). Existing deal permissions apply.</p><p><Link className="btn primary" href="/deals/new">Create BD deal</Link> <Link className="btn" href="/deals">Open Deals</Link></p><DealTable title="Update an existing deal" deals={snapshot.selected} /></>}
      </div>
      <footer className="bd-footer">APLYD Practice · Live SHO deal data · Only deals visible to your account</footer>
    </>}
  </Page>;
}
