export const DEAL_DATE_FIELDS = [
  { value: "submissionDeadline", label: "Submission deadline" },
  { value: "expectedClose", label: "Expected close" },
  { value: "createdAt", label: "Created date" },
  { value: "stageChangedAt", label: "Stage entered date" },
] as const;
export type DealDateField = typeof DEAL_DATE_FIELDS[number]["value"];
export type DealDateFilter = { field: DealDateField; start: string; end: string; undated: "include" | "exclude" | "only" };

/** Calendar-only deal dates stay calendar dates; timestamps use the business timezone. */
export function dealCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function matchesDealDate(deal: Partial<Record<DealDateField, string | null>>, filter: DealDateFilter) {
  if (filter.start && filter.end && filter.start > filter.end) return false;
  const date = dealCalendarDate(deal[filter.field]);
  if (!date) return filter.undated !== "exclude";
  if (filter.undated === "only") return false;
  return (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end);
}
