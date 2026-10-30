// Shared India-time helpers for task forms and quick add.
import { addDays, formatDueDate, parseDueDate, startOfTodayIST } from "@/lib/dates";

const IST_MS = 5.5 * 3600_000;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The IST calendar parts of an instant. */
export function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay(), h: x.getUTCHours(), min: x.getUTCMinutes() };
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A due date from a task form: YYYY-MM-DD, or a relative phrase the server resolves.
 * Relative phrases mean the next occurrence AFTER today in India time (so "Monday" on a Monday is next Monday).
 * Returns the stored date (midnight IST) or throws a validation error.
 */
export function resolveDue(input: string, now = new Date()): Date {
  const s = input.trim().toLowerCase();
  const today = startOfTodayIST(now);
  const wd = istParts(now).wd;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = parseDueDate(s);
    if (Number.isNaN(d.getTime()) || formatDueDate(d) !== s) throw new Error(`"${input}" is not a real date.`);
    return d;
  }
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  const named = DAY_NAMES.indexOf(s.replace(/^(next|this|on)\s+/, ""));
  if (named >= 0) return addDays(today, ((named - wd + 7) % 7) || 7);
  if (s === "next week") return addDays(today, ((1 - wd + 7) % 7) || 7); // next Monday
  if (s === "end of week") return addDays(today, ((5 - wd + 7) % 7) || 7); // next Friday
  if (s === "end of month" || s === "end of the month") {
    const p = istParts(now);
    let last = new Date(Date.UTC(p.y, p.m + 1, 0) - IST_MS);
    if (last.getTime() <= today.getTime()) last = new Date(Date.UTC(p.y, p.m + 2, 0) - IST_MS);
    return last;
  }
  const inDays = /^in (\d{1,3}) days?$/.exec(s);
  if (inDays) return addDays(today, Number(inDays[1]));
  throw new Error(`I could not turn "${input}" into a date. Ask the person for a date.`);
}
