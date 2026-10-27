"use client";
import Link from "next/link";
import { Confirm, Skeleton } from "@/components/ui";
import { useState } from "react";
import { api, dueLabel, isOverdue, useGet } from "@/components/api";
import { OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { DEAL_DATE_FIELDS, matchesDealDate, type DealDateFilter } from "@/lib/deal-date-filter";
import { money } from "@/components/DealPanel";
import { DealBoard, inLifecycle, opportunityGroups, sortDeals, totals, type BoardDeal, type BoardStage, type DealSort } from "@/components/DealBoard";
import { Page, useMe } from "../Shell";

import "./deals-approved.css";
type D = BoardDeal;

export default function DealsView() {
  const [lifecycle, setLifecycle] = useState<"sales" | "delivery">("sales");
  const [mine, setMine] = useState(false);
  const [old, setOld] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [pipe, setPipe] = useState("");
  const [opportunities, setOpportunities] = useState<string[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [sort, setSort] = useState<DealSort>("stage");
  const [dateFilter, setDateFilter] = useState<DealDateFilter>({ field: "submissionDeadline", start: "", end: "", undated: "include" });
  const [restore, setRestore] = useState<{ id: string; name: string } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const invalidRange = !!(dateFilter.start && dateFilter.end && dateFilter.start > dateFilter.end);
  const me = useMe();
  void me;
  const pipes = useGet<{ pipelines: { id: string; key: string; name: string; stages: BoardStage[] }[] }>("/api/deals/pipelines");
  const cur = pipes.data?.pipelines.find((p) => p.id === pipe) ?? pipes.data?.pipelines[0];
  const { data, loading, error, reload } = useGet<{ deals: D[] }>(cur ? `/api/deals?pipelineId=${cur.id}&lifecycle=${lifecycle}${mine ? "&mine=true" : ""}${old ? "&archived=true" : ""}` : null);
  const trash = useGet<{ deals: { id: string; name: string }[] }>("/api/deals?deleted=true&lifecycle=all");
  const filteredDeals = (data?.deals ?? []).filter(d => inLifecycle(d, lifecycle) && matchesDealDate(d, dateFilter)
    && (!opportunities.length || opportunities.includes(d.opportunityType ?? "unclassified"))
    && (!stages.length || (!!d.stage && stages.includes(d.stage.id))));
  const deals = sortDeals(filteredDeals, sort, cur?.stages ?? []);
  const groups = opportunityGroups(deals);
  return (
    <Page className="deals-approved" title="Deals" sub="Deals you lead or belong to"
      actions={<>
        <div className="seg" role="group" aria-label="Which deals">
          <button aria-pressed={!mine} onClick={() => setMine(false)}>All mine</button>
          <button aria-pressed={mine} onClick={() => setMine(true)}>Only my deals</button>
        </div>
        <button className="btn ghost" aria-pressed={old} onClick={() => setOld(!old)}>{old ? "Show live" : "Show archived"}</button>
        <Link className="btn" href="/deals/new">+ New deal</Link>
      </>}>
      <div className="deal-work-tabs">
        <div className="seg" role="group" aria-label="Deal lifecycle">
          <button aria-pressed={lifecycle === "sales"} onClick={() => setLifecycle("sales")}>Sales pipeline</button>
          <button aria-pressed={lifecycle === "delivery"} onClick={() => setLifecycle("delivery")}>Delivery projects</button>
        </div>
        <div className="seg" role="group" aria-label="Layout">
          <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>
      <div id="deal-filters" className="deal-filterbar" aria-label="Deal filters">
        <CheckFilter label="Opportunity types" values={opportunities} onChange={setOpportunities} options={[...OPPORTUNITY_TYPES.map(type => ({ value: type.value, label: type.label })), { value: "unclassified", label: "Unclassified" }]} />
        <CheckFilter label="Stages" values={stages} onChange={setStages} options={(cur?.stages ?? []).map(item => ({ value: item.id, label: item.name }))} />
        <label><span>Date basis</span><select value={dateFilter.field} onChange={e => setDateFilter({ ...dateFilter, field: e.target.value as DealDateFilter["field"] })}>
          {DEAL_DATE_FIELDS.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
        </select></label>
        <label><span>From</span><input type="date" value={dateFilter.start} onChange={e => setDateFilter({ ...dateFilter, start: e.target.value })} /></label>
        <label><span>Through</span><input type="date" value={dateFilter.end} onChange={e => setDateFilter({ ...dateFilter, end: e.target.value })} /></label>
        <label><span>No date</span><select value={dateFilter.undated} onChange={e => setDateFilter({ ...dateFilter, undated: e.target.value as DealDateFilter["undated"] })}>
          <option value="include">Include</option><option value="exclude">Exclude</option><option value="only">Only no date</option>
        </select></label>
        <label><span>Sort by</span><select value={sort} onChange={e => setSort(e.target.value as DealSort)}>
          <option value="stage">Stage order</option><option value="name-asc">Deal name A–Z</option><option value="name-desc">Deal name Z–A</option><option value="date-asc">Submission deadline earliest</option><option value="date-desc">Submission deadline latest</option>
        </select></label>
      </div>
      <div className="deal-filter-meta"><span>{deals.length} shown · inclusive dates (IST){deals.filter(d => !d[dateFilter.field]).length ? ` · ${deals.filter(d => !d[dateFilter.field]).length} without a date` : ""}</span><span className="deal-filter-actions"><button className="link" onClick={() => { setOpportunities([]); setStages([]); }}>Clear type and stage filters</button><button className="link" onClick={() => setDateFilter({ field: "submissionDeadline", start: "", end: "", undated: "include" })}>Clear timeline filter</button><button className="link" onClick={() => { setOpportunities([]); setStages([]); setDateFilter({ field: "submissionDeadline", start: "", end: "", undated: "include" }); setSort("stage"); }}>Clear all</button></span></div>
      {invalidRange && <p className="err" role="alert">From must be on or before Through.</p>}
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist" aria-label="Pipeline">
          {pipes.data?.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={cur?.id === p.id} onClick={() => { setPipe(p.id); setStages([]); }}>{p.name}</button>)}
        </div>
      </div>
      {loading && !data && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && deals.length === 0 && <div className="card empty" role="region" aria-label="No matching deals">
        {lifecycle === "delivery" ? <><b>No matching delivery projects.</b><br />In the Bid sales pipeline, move an existing Won deal to Ongoing Projects to begin delivery.</>
          : <><b>No matching sales deals.</b><br />Create a deal to track an opportunity.<div className="empty-act"><Link className="btn" href="/deals/new">New deal</Link></div></>}
      </div>}
      {data && cur && groups.filter(group => group.deals.length > 0).map(group => {
        const t = totals(group.deals);
        return <section key={group.key} aria-label={`${group.label} ${lifecycle}`} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18 }}>{group.label} · {group.deals.length} {lifecycle === "delivery" ? "delivery projects" : "deals"}</h2>
          <p className="sub">{lifecycle === "delivery" ? "Delivery only; excluded from sales pipeline counts." : "All shown sales stages, including outcomes."} {t.sums.join(" · ")}{t.unknown > 0 ? ` · ${t.unknown} without value` : ""}</p>
          {view === "board" && !old ? <DealBoard deals={group.deals} stages={cur.stages} lifecycle={lifecycle} bid={cur.key === "DEAL_BID"} sort={sort} onChange={reload} />
            : <DealList deals={group.deals} />}
        </section>;
      })}

      <details className="deal-trash" aria-label="Deal Trash">
        <summary>Trash</summary>
        <p className="hint">Deleted deals stay recoverable. Their tasks, notes, parties, memberships and history are preserved.</p>
        {trash.error && <div className="err" role="alert">{trash.error} <button className="link" onClick={trash.reload}>Retry</button></div>}
        {trash.data?.deals.map(deal => <div className="box" key={deal.id}><b>{deal.name}</b>{" "}<button className="btn ghost sm" onClick={() => { setRestore(deal); setRestoreError(null); }}>Restore deal…</button></div>)}
        {trash.data && !trash.data.deals.length && <p className="hint">No deleted deals.</p>}
      </details>
      {restore && <Confirm title={`Restore “${restore.name}”?`} yes="Restore deal" body="All preserved work, parties and memberships return. The deal returns to its previous active or archived state. Members are notified."
        busy={restoring} error={restoreError} onNo={() => setRestore(null)} onYes={async () => {
          setRestoring(true); const result = await api("POST", `/api/projects/${restore.id}/restore`, {}); setRestoring(false);
          if (result.ok) { setRestore(null); reload(); trash.reload(); } else setRestoreError(result.error ?? "Could not restore deal.");
        }} />}

    </Page>
  );
}

function sortLabel(sort: DealSort) {
  return ({ stage: "Stage order", "name-asc": "Deal name A–Z", "name-desc": "Deal name Z–A", "date-asc": "Submission deadline earliest", "date-desc": "Submission deadline latest" })[sort];
}

function CheckFilter({ label, options, values, onChange }: { label: string; options: { value: string; label: string }[]; values: string[]; onChange: (values: string[]) => void }) {
  return <label className="deal-filter-field"><span>{label}</span><details className="deal-check-filter">
    <summary>{values.length ? `${values.length} selected` : `All ${label.toLowerCase()}`}<span aria-hidden="true">⌄</span></summary>
    <div className="deal-check-menu">{options.map(option => <label key={option.value}><input type="checkbox" checked={values.includes(option.value)} onChange={() => onChange(values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value])} /> {option.label}</label>)}
      {values.length > 0 && <button type="button" className="link" onClick={() => onChange([])}>Clear {label.toLowerCase()}</button>}
    </div>
  </details></label>;
}

function DealList({ deals }: { deals: D[] }) {
  return <div className="deal-list-scroll" tabIndex={0} role="region" aria-label="Deals table"><table className="tbl">
    <thead><tr><th>Deal</th><th>Opportunity type</th><th>Organisation</th><th>Stage</th><th>Value</th><th>Next step</th><th>Leader</th></tr></thead>
    <tbody>{deals.map(d => <tr key={d.id}>
      <td><Link href={`/projects/${d.id}`}>{d.name}</Link> {d.stalled && <span className="chip gold">Stalled</span>}</td>
      <td>{OPPORTUNITY_TYPES.find(o => o.value === d.opportunityType)?.label ?? "Unclassified"}</td>
      <td>{d.organisation ? <Link href={`/accounts/${d.organisation.id}`}>{d.organisation.name}</Link> : "—"}</td>
      <td><span className="chip">{d.stage?.name}{d.stage?.isRetired ? " · legacy stage" : ""}</span><div style={{ fontSize: 12, color: "var(--muted)" }}>{d.pipeline?.name}</div></td>
      <td>{money(d.value, d.currency)}</td>
      <td>{d.nextStep ? <>{d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">None</span> : "—"}</td>
      <td>{d.leader?.name ?? "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}
