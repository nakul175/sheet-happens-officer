import { matchesDealDate, type DealDateFilter } from "@/lib/deal-date-filter";
import type { AthenaRole, OpportunityType } from "@/lib/deal-classification";

export type BdDeal = {
  id: string; name: string; archived?: boolean; deletedAt?: string | null;
  stage: { name: string; category: string } | null;
  pipeline?: { name: string } | null;
  organisation?: { name: string; country?: string | null } | null;
  leader?: { name: string } | null;
  partner?: string | null; athenaRole?: AthenaRole | null;
  budgetUsd?: number | null; netFeeRevenueUsd?: number | null; pwinAdjustedNfrUsd?: number | null;
  probability?: number | null; opportunityType?: OpportunityType | null;
  submissionDeadline?: string | null; expectedClose?: string | null; createdAt?: string | null; stageChangedAt?: string | null;
};
export const BD_PANELS = [
  ["summary", "Summary"], ["wip", "WIP"], ["submissions", "Submissions"], ["eoicv", "EOI/CV"],
  ["evaluation", "Under Eval"], ["hpp", "HPP"], ["shortlisted", "Shortlisted"], ["wins", "Wins"],
  ["losses", "Losses"], ["kms", "KMS & CNPS"], ["snapshots", "Pipeline snapshots"], ["update", "Add/Update BD Entry"],
] as const;
export type BdPanel = typeof BD_PANELS[number][0];
export type BdBucket = Exclude<BdPanel, "summary" | "kms" | "snapshots" | "update">;
export const isHppStage = (name: string) => /\bhpp\b|high[- ]priority pursuit/i.test(name);
export const isShortlistedStage = (name: string) => /shortlist/i.test(name);

/** Current stage snapshot only; no invented historical submission events or HPP threshold. */
export function dealBuckets(deal: BdDeal): BdBucket[] {
  if (deal.archived || deal.deletedAt || !deal.stage) return [];
  const { name, category } = deal.stage;
  if (category === "DELIVERY") return [];
  if (category === "DONE") return ["wins"];
  if (category === "LOST") return ["losses"];
  const result: BdBucket[] = [];
  if (isHppStage(name)) result.push("hpp");
  if (isShortlistedStage(name)) result.push("shortlisted");
  const submitted = /\bsubmitted\b|submission complete/i.test(name);
  if (submitted) result.push(deal.opportunityType === "EOI" || deal.opportunityType === "CV_LTA" ? "eoicv" : "submissions");
  if (submitted || /under eval|awaiting result|contracting/i.test(name) || result.includes("hpp") || result.includes("shortlisted")) result.push("evaluation");
  if (!result.length && ["ACTIVE", "NOT_STARTED", "PAUSED"].includes(category)) result.push("wip");
  return result;
}

export type UsdTotal = { cents: bigint | null; known: number; total: number };
const cents = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0 ? null : BigInt(Math.round(value * 100));
export function totalUsd(deals: BdDeal[], field: "budgetUsd" | "netFeeRevenueUsd" | "pwinAdjustedNfrUsd", weighted = false): UsdTotal {
  let sum = BigInt(0), known = 0;
  for (const deal of deals) {
    const amount = cents(deal[field]);
    if (amount === null || (weighted && (deal.probability == null || !Number.isInteger(deal.probability) || deal.probability < 0 || deal.probability > 100))) continue;
    sum += weighted ? (amount * BigInt(deal.probability!) + BigInt(50)) / BigInt(100) : amount;
    known++;
  }
  return { cents: known ? sum : null, known, total: deals.length };
}
export function usd(value: number | bigint | null | undefined) {
  const amount = typeof value === "bigint" ? value : cents(value);
  if (amount === null) return "NA";
  return `USD ${(amount / BigInt(100)).toLocaleString("en-US")}.${(amount % BigInt(100)).toString().padStart(2, "0")}`;
}
export function bdSnapshot(deals: BdDeal[], filter: DealDateFilter) {
  const selected = deals.filter(d => !d.archived && !d.deletedAt && matchesDealDate(d, filter));
  const buckets = Object.fromEntries(BD_PANELS.filter(([id]) => !["summary", "kms", "snapshots", "update"].includes(id)).map(([id]) => [id, selected.filter(d => dealBuckets(d).includes(id as BdBucket))])) as Record<BdBucket, BdDeal[]>;
  return { selected, buckets };
}
