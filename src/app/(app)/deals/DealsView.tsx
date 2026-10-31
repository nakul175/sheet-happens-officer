"use client";
import Link from "next/link";
import { Confirm, Skeleton } from "@/components/ui";
import { useEffect, useId, useRef, useState } from "react";
import { api, dueLabel, isOverdue, useGet } from "@/components/api";
import { OPPORTUNITY_TYPES } from "@/lib/deal-classification";
import { DEAL_DATE_FIELDS, matchesDealDate, type DealDateFilter } from "@/lib/deal-date-filter";
import { money } from "@/components/DealPanel";
import { DealBdFacts } from "@/components/DealBdFields";
import { DealBoard, inLifecycle, opportunityFilterValue, opportunityGroups, sortDeals, totals, type BoardDeal, type BoardStage, type DealSort } from "@/components/DealBoard";
import { Page, useMe } from "../Shell";

import "./deals-approved.css";
type D = BoardDeal;

export default function DealsView() {
  const [lifecycle, setLifecycle] = useState<"sales" | "delivery">("sales");
  const [filtersOpen, setFiltersOpen] = useState(false);
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
    && (!opportunities.length || opportunities.includes(opportunityFilterValue(d.opportunityType)))
    && (!stages.length || (!!d.stage && stages.includes(d.stage.id))));
  const deals = sortDeals(filteredDeals, sort, cur?.stages ?? []);
  const groups = opportunityGroups(deals);
  const openCommercial = groups[0].deals.filter(d => ["NOT_STARTED", "ACTIVE", "PAUSED"].includes(d.stage?.category ?? ""));
  const openTotals = totals(openCommercial);
  const dateActive = !!(dateFilter.start || dateFilter.end || dateFilter.undated !== "include" || dateFilter.field !== "submissionDeadline");
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
      <div className="seg" role="group" aria-label="Deal lifecycle" style={{ marginBottom: 12 }}>
        <button aria-pressed={lifecycle === "sales"} onClick={() => setLifecycle("sales")}>Sales pipeline</button>
        <button aria-pressed={lifecycle === "delivery"} onClick={() => setLifecycle("delivery")}>Delivery projects</button>
      </div>
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className="seg deal-pipeline-switcher" role="tablist" aria-label="Pipeline">
          {pipes.data?.pipelines.map((p) => <button key={p.id} role="tab" aria-selected={cur?.id === p.id} onClick={() => { setPipe(p.id); setStages([]); }}>{p.name}</button>)}
        </div>
        <span className="sp" />
        <div className="seg" role="group" aria-label="Layout">
          <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>
      {cur && <p className="hint deal-pipeline-purpose">{cur.key === "DEAL_BID" ? "Formal bids and submission deadlines." : "Proactive opportunities and conversations."}</p>}
      <div className="deal-toolbar" aria-label="Deal filters and sorting">
        <MultiFilter label="Opportunity types" values={opportunities} onChange={setOpportunities} options={[...OPPORTUNITY_TYPES.map(type => ({ value: type.value, label: type.label })), { value: "unclassified", label: "Unclassified" }]} />
        <MultiFilter label="Stages" values={stages} onChange={setStages} options={(cur?.stages ?? []).map(item => ({ value: item.id, label: item.name }))} />
        <label className="deal-filter-control">Sort <select className="in" value={sort} onChange={e => setSort(e.target.value as DealSort)}>
          <option value="stage">Stage order</option><option value="name-asc">Deal name A–Z</option><option value="name-desc">Deal name Z–A</option><option value="date-asc">Submission deadline earliest</option><option value="date-desc">Submission deadline latest</option>
        </select></label>
        <button className="btn ghost deal-date-toggle" aria-expanded={filtersOpen} aria-controls="deal-filters" onClick={() => setFiltersOpen(!filtersOpen)}>Date filters{dateActive ? " · active" : ""}</button>
      </div>
      <section id="deal-filters" hidden={!filtersOpen} className="deal-date-panel" aria-label="Deal date filters">
        <label>Date basis <select className="in" value={dateFilter.field} onChange={e => setDateFilter({ ...dateFilter, field: e.target.value as DealDateFilter["field"] })}>
          {DEAL_DATE_FIELDS.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
        </select></label>
        <label>From <input className="in" type="date" value={dateFilter.start} onChange={e => setDateFilter({ ...dateFilter, start: e.target.value })} /></label>
        <label>Through <input className="in" type="date" value={dateFilter.end} onChange={e => setDateFilter({ ...dateFilter, end: e.target.value })} /></label>
        <label>No date <select className="in" value={dateFilter.undated} onChange={e => setDateFilter({ ...dateFilter, undated: e.target.value as DealDateFilter["undated"] })}>
          <option value="include">Include</option><option value="exclude">Exclude</option><option value="only">Only no date</option>
        </select></label>
        <p className="hint">Inclusive dates (IST). {deals.filter(d => !d[dateFilter.field]).length} shown without a date.</p>
        <button className="link" onClick={() => setDateFilter({ field: "submissionDeadline", start: "", end: "", undated: "include" })}>Clear timeline filter</button>
      </section>
      <div className="deal-results" role="status"><span>{data ? `${deals.length} ${lifecycle === "delivery" ? "delivery projects" : "deals"}` : "Loading deals…"}</span>
        {data && lifecycle === "sales" && <span aria-label="Open commercial pipeline">{old ? "Archived open-stage" : "Open"} RFP/RFA + OTC: {openCommercial.length}{openTotals.sums.length > 0 ? ` · ${openTotals.sums.join(" · ")}` : ""}{openTotals.unknown ? ` · ${openTotals.unknown} without value` : ""}</span>}
        {(opportunities.length > 0 || stages.length > 0 || dateActive) && <button className="link" onClick={() => { setOpportunities([]); setStages([]); setDateFilter({ field: "submissionDeadline", start: "", end: "", undated: "include" }); }}>Clear filters</button>}
      </div>
      {invalidRange && <p className="err" role="alert">From must be on or before Through.</p>}
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
          <p className="hint">{t.sums.join(" · ")}{t.unknown > 0 ? `${t.sums.length ? " · " : ""}${t.unknown} without value` : ""}</p>
          {group.deals.length === 0 ? <p className="sub">No {group.label} {lifecycle === "delivery" ? "delivery projects" : "deals"}.</p>
            : view === "board" && !old ? <DealBoard deals={group.deals} stages={cur.stages} lifecycle={lifecycle} bid={cur.key === "DEAL_BID"} sort={sort} onChange={reload} />
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

function MultiFilter({ label, options, values, onChange }: { label: string; options: { value: string; label: string }[]; values: string[]; onChange: (values: string[]) => void }) {
  const box = useRef<HTMLDetailsElement>(null);
  const labelId = useId();
  useEffect(() => {
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) box.current.open = false; };
    // A phone popup is in flow: dismiss after click targeting, so closing it cannot move the next control between pointer-down and pointer-up.
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, []);
  return <div className="deal-multi-control"><span id={labelId} className="deal-control-label">{label}</span><details className="deal-multi" ref={box} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (box.current) { box.current.open = false; box.current.querySelector("summary")?.focus(); } } }}>
    <summary aria-labelledby={`${labelId} ${labelId}-value`}><span id={`${labelId}-value`}>{values.length === 1 ? options.find(option => option.value === values[0])?.label ?? "1 selected" : values.length ? `${values.length} selected` : "All"}</span><span className="select-chevron" aria-hidden="true" /></summary>
    <div className="deal-multi-popup" role="group" aria-label={label}>
      {options.map(option => <label key={option.value}><input type="checkbox" checked={values.includes(option.value)} onChange={() => onChange(values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value])} /><span>{option.label}</span></label>)}
      {values.length > 0 && <button type="button" className="link" onClick={() => onChange([])}>Clear {label.toLowerCase()}</button>}
      {!options.length && <p className="hint">No available options.</p>}
    </div>
  </details></div>;
}

function DealList({ deals }: { deals: D[] }) {
  return <div className="deal-list-scroll" tabIndex={0} role="region" aria-label="Deals table"><table className="tbl">
    <thead><tr><th>Deal</th><th>Opportunity type</th><th>Organisation</th><th>Stage</th><th>Value</th><th>Next step</th><th>Leader</th></tr></thead>
    <tbody>{deals.map(d => <tr key={d.id}>
      <td><Link href={`/projects/${d.id}`}>{d.name}</Link> {d.stalled && <span className="chip gold">Stalled</span>}</td>
      <td>{OPPORTUNITY_TYPES.find(o => o.value === d.opportunityType)?.label ?? "Unclassified"}</td>
      <td>{d.organisation ? <Link href={`/accounts/${d.organisation.id}`}>{d.organisation.name}</Link> : "—"}</td>
      <td><span className="chip">{d.stage?.name}{d.stage?.isRetired ? " · legacy stage" : ""}</span><div style={{ fontSize: 12, color: "var(--muted)" }}>{d.pipeline?.name}</div></td>
      <td>{money(d.value, d.currency)}<DealBdFacts values={d} /></td>
      <td>{d.nextStep ? <>{d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">None</span> : "—"}</td>
      <td>{d.leader?.name ?? "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}
