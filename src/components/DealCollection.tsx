"use client";
// SHO-2642: one entry point for already-authorised deal collections. It does not
// fetch, filter, grant access, or change the caller's archive/Trash policy.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { DealBoard, type BoardDeal } from "@/components/DealBoard";
import { DealBdFacts } from "@/components/DealBdFields";
import { money } from "@/components/DealPanel";
import { dueLabel, isOverdue } from "@/components/api";
import { OPPORTUNITY_TYPES } from "@/lib/deal-classification";

export type OrganisationDeal = {
  projectId: string; name: string; role: string; archived: boolean;
  stage: { name: string } | null; pipeline: string | null; leader: { name: string } | null;
};
export type NeedsStepDeal = { id: string; name: string; stage: string | null };
type Props = ({ view: "board" } & ComponentProps<typeof DealBoard>)
  | { view: "list"; deals: BoardDeal[]; label?: string }
  | { view: "organisation"; deals: OrganisationDeal[] }
  | { view: "needs-step"; deals: NeedsStepDeal[]; renderAction: (projectId: string) => ReactNode };
type Column<T> = { label: string; cell: (deal: T) => ReactNode };

function DealName({ id, name, bold = false }: { id: string; name: string; bold?: boolean }) {
  return <Link href={`/projects/${id}`}>{bold ? <b>{name}</b> : name}</Link>;
}
function DealTable<T>({ deals, keyOf, columns, className, label }: {
  deals: T[]; keyOf: (deal: T) => string; columns: Column<T>[]; className: string; label: string;
}) {
  return <div className={className} tabIndex={0} role="region" aria-label={label}><table className="tbl" aria-label={label}>
    <thead><tr>{columns.map(c => <th scope="col" key={c.label}>{c.label}</th>)}</tr></thead>
    <tbody>{deals.map(d => <tr key={keyOf(d)}>{columns.map(c => <td key={c.label}>{c.cell(d)}</td>)}</tr>)}</tbody>
  </table></div>;
}
const listColumns: Column<BoardDeal>[] = [
  { label: "Deal", cell: d => <><DealName id={d.id} name={d.name} /> {d.stalled && <span className="chip gold">Stalled</span>}</> },
  { label: "Opportunity type", cell: d => OPPORTUNITY_TYPES.find(o => o.value === d.opportunityType)?.label ?? "Unclassified" },
  { label: "Organisation", cell: d => d.organisation ? <Link href={`/accounts/${d.organisation.id}`}>{d.organisation.name}</Link> : "—" },
  { label: "Stage", cell: d => <><span className="chip">{d.stage?.name}{d.stage?.isRetired ? " · legacy stage" : ""}</span><div style={{ fontSize: 12, color: "var(--muted)" }}>{d.pipeline?.name}</div></> },
  { label: "Value", cell: d => <>{money(d.value, d.currency)}<DealBdFacts values={d} label={`BD details for ${d.name}`} /></> },
  { label: "Next step", cell: d => d.nextStep ? <>{d.nextStep.title} · <span className={isOverdue(d.nextStep.dueDate) ? "over" : ""}>{dueLabel(d.nextStep.dueDate)}</span></> : d.needsNextStep ? <span className="chip red">None</span> : "—" },
  { label: "Leader", cell: d => d.leader?.name ?? "—" },
];
const organisationColumns: Column<OrganisationDeal>[] = [
  { label: "Deal", cell: d => <DealName id={d.projectId} name={d.name} /> },
  { label: "Relationship", cell: d => d.role },
  { label: "Stage", cell: d => <>{d.stage?.name ?? "—"} <span style={{ color: "var(--muted)" }}>{d.pipeline}</span></> },
  { label: "Leader", cell: d => d.leader?.name ?? "—" },
];
export function DealCollection(props: Props) {
  if (props.view === "board") return <DealBoard deals={props.deals} stages={props.stages} bid={props.bid} lifecycle={props.lifecycle} sort={props.sort} canMove={props.canMove} onChange={props.onChange} label={props.label} />;
  if (props.view === "list") return <DealTable deals={props.deals} keyOf={d => d.id} columns={listColumns} className="deal-list-scroll" label={props.label ?? "Deals table"} />;
  if (props.view === "organisation") return <DealTable deals={props.deals} keyOf={d => `${d.projectId}:${d.role}`} columns={organisationColumns} className="acct-scroll" label="Open deals" />;
  return <>{props.deals.map(d => <div key={d.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <DealName id={d.id} name={d.name} bold /> <span className="chip grey">{d.stage}</span>{props.renderAction(d.id)}
  </div>)}</>;
}
