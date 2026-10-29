import { ApiError } from "@/lib/http";
import { DeadlineError, resolveSubmissionDeadline, submissionLocalTime, type DeadlineChoice } from "@/lib/submission-deadline";
export type DeadlineInput = { submissionDeadline?: string | null; submissionDeadlineTime?: string | null; submissionDeadlineZone?: string | null; submissionDeadlineChoice?: DeadlineChoice };
export type StoredDeadline = { submissionDeadline: Date | null; submissionDeadlineAt: Date | null; submissionDeadlineZone: string | null };
const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
export function deadlineJSON(row: StoredDeadline) {
  return { submissionDeadline: day(row.submissionDeadline), submissionDeadlineAt: row.submissionDeadlineAt?.toISOString() ?? null, submissionDeadlineZone: row.submissionDeadlineZone, submissionDeadlineTime: submissionLocalTime(row.submissionDeadlineAt, row.submissionDeadlineZone) };
}
export function deadlinePatch(input: DeadlineInput, current?: StoredDeadline, required = false) {
  const touched = [input.submissionDeadline, input.submissionDeadlineTime, input.submissionDeadlineZone, input.submissionDeadlineChoice].some(v => v !== undefined);
  if (current && !touched) return {};
  const date = input.submissionDeadline === undefined ? day(current?.submissionDeadline ?? null) : input.submissionDeadline;
  const time = input.submissionDeadlineTime === undefined ? submissionLocalTime(current?.submissionDeadlineAt, current?.submissionDeadlineZone) : input.submissionDeadlineTime;
  const zone = input.submissionDeadlineZone === undefined ? current?.submissionDeadlineZone ?? null : input.submissionDeadlineZone;
  // Editing other facts (or resubmitting the same deadline) must not invent an instant or change a DST occurrence.
  if (current && date === day(current.submissionDeadline) && time === submissionLocalTime(current.submissionDeadlineAt, current.submissionDeadlineZone) && zone === current.submissionDeadlineZone && !input.submissionDeadlineChoice) return {};
  if (!date && !time && !zone && !required && !current?.submissionDeadlineAt) return { submissionDeadline: null, submissionDeadlineAt: null, submissionDeadlineZone: null };
  if (!time && !zone && !required && !current?.submissionDeadlineAt) return { submissionDeadline: date ? new Date(`${date}T00:00:00Z`) : null, submissionDeadlineAt: null, submissionDeadlineZone: null };
  if (!date || !time || !zone) throw new ApiError(400, "A Bid submission deadline needs a date, time, and timezone. An unchanged legacy date-only deadline may stay date-only.");
  try {
    return { submissionDeadline: new Date(`${date}T00:00:00Z`), submissionDeadlineAt: resolveSubmissionDeadline(date, time, zone, input.submissionDeadlineChoice), submissionDeadlineZone: zone };
  } catch (error) {
    if (error instanceof DeadlineError) throw new ApiError(400, error.message, error.choices ? { deadlineChoices: error.choices } : undefined);
    throw error;
  }
}
