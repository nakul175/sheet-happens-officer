import type { Prisma } from "@/generated/prisma/client";
export const DEAL_DATE_BASES = [
  { value: "submissionDeadline", label: "Submission deadline" },
  { value: "createdAt", label: "Created date" },
  { value: "expectedClose", label: "Expected close" },
] as const;
export type DealDateBasis = (typeof DEAL_DATE_BASES)[number]["value"];
export type DealDateFilter = { basis: DealDateBasis; from?: string; to?: string; includeUndated: boolean };
export class DealDateFilterError extends Error {}
const publicValidationMessages = new Set([
  "From date must be a valid calendar date (YYYY-MM-DD).",
  "To date must be a valid calendar date (YYYY-MM-DD).",
  "Include undated must be true or false.",
  "Choose Submission deadline, Created date or Expected close as the date basis.",
  "Choose at least one From or To date to apply the date filter.",
  "From date must be on or before To date.",
]);
/** Only fixed validation copy may reach an ApiError, even for a forged error instance. */
export function publicDealDateError(value: unknown) {
  return value instanceof DealDateFilterError && publicValidationMessages.has(value.message)
    ? value.message : "Choose a valid deal date filter.";
}
const IST_OFFSET_MS = 330 * 60_000;
function day(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === "0000") throw new DealDateFilterError(`${label} must be a valid calendar date (YYYY-MM-DD).`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new DealDateFilterError(`${label} must be a valid calendar date (YYYY-MM-DD).`);
  return value;
}
export function parseDealDateFilter(input: { basis?: unknown; from?: unknown; to?: unknown; includeUndated?: unknown }): DealDateFilter | undefined {
  const from = day(input.from, "From date"), to = day(input.to, "To date");
  const basis = input.basis === "" || input.basis === null ? undefined : input.basis;
  const undated = input.includeUndated;
  if (undated !== undefined && undated !== null && undated !== "" && undated !== true && undated !== false && undated !== "true" && undated !== "false") throw new DealDateFilterError("Include undated must be true or false.");
  const includeUndated = undated === true || undated === "true";
  if (!basis && !from && !to && !includeUndated) return undefined;
  if (!DEAL_DATE_BASES.some(option => option.value === basis)) throw new DealDateFilterError("Choose Submission deadline, Created date or Expected close as the date basis.");
  if (!from && !to) throw new DealDateFilterError("Choose at least one From or To date to apply the date filter.");
  if (from && to && from > to) throw new DealDateFilterError("From date must be on or before To date.");
  return { basis: basis as DealDateBasis, ...(from ? { from } : {}), ...(to ? { to } : {}), includeUndated };
}
function bounds(filter: DealDateFilter, timed: boolean): Prisma.DateTimeFilter {
  const offset = timed ? IST_OFFSET_MS : 0;
  return {
    ...(filter.from ? { gte: new Date(Date.parse(`${filter.from}T00:00:00.000Z`) - offset) } : {}),
    ...(filter.to ? { lt: new Date(Date.parse(`${filter.to}T00:00:00.000Z`) + 86400_000 - offset) } : {}),
  };
}
/** Calendar dates are inclusive in IST. Legacy date-only values keep their stored calendar date. */
export function dealDateWhere(input?: DealDateFilter): Prisma.ProjectWhereInput | undefined {
  if (!input) return undefined;
  const filter = parseDealDateFilter(input)!;
  if (filter.basis === "createdAt") return { createdAt: bounds(filter, true) };
  const dated: Prisma.ProjectWhereInput = filter.basis === "expectedClose"
    ? { deal: { is: { expectedClose: bounds(filter, false) } } }
    : { deal: { is: { OR: [
      { submissionDeadlineHasTime: false, submissionDeadline: bounds(filter, false) },
      { submissionDeadlineHasTime: true, submissionDeadline: bounds(filter, true) },
    ] } } };
  return filter.includeUndated ? { OR: [dated, { deal: { is: null } }, { deal: { is: { [filter.basis]: null } } }] } : dated;
}
export function dealDateQuery(filter?: DealDateFilter) {
  if (!filter) return "";
  const query = new URLSearchParams({ dateBasis: filter.basis, includeUndated: String(filter.includeUndated) });
  if (filter.from) query.set("dateFrom", filter.from);
  if (filter.to) query.set("dateTo", filter.to);
  return query.toString();
}
