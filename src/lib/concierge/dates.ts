// India-time helpers for the concierge: periods, readable dates and relative-date resolution (SHO-US-8.4 AC5).
import { addDays, formatDueDate, parseDueDate, startOfTodayIST } from "@/lib/dates";

const IST_MS = 5.5 * 3600_000;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The IST calendar parts of an instant. */
export function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay(), h: x.getUTCHours(), min: x.getUTCMinutes() };
}

/** "Monday 19 October 2026" for an instant (its India-time date). */
export function fullDate(d: Date) {
  const p = istParts(d);
  return `${WEEKDAYS[p.wd]} ${p.d} ${MONTHS[p.m]} ${p.y}`;
}
export function shortDate(d: Date) {
  const p = istParts(d);
  return `${p.d} ${MONTHS[p.m].slice(0, 3)} ${p.y}`;
}
export function fullDateTime(d: Date) {
  const p = istParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${fullDate(d)}, ${h12}:${String(p.min).padStart(2, "0")} ${p.h < 12 ? "am" : "pm"} India time`;
}

/** Start of the calendar month (India time) containing `now`. */
export function monthStartIST(now = new Date()) {
  const p = istParts(now);
  return new Date(Date.UTC(p.y, p.m, 1) - IST_MS);
}
export function nextMonthStartIST(now = new Date()) {
  const p = istParts(now);
  return new Date(Date.UTC(p.y, p.m + 1, 1) - IST_MS);
}
/** Monday 00:00 India time of the week containing `now`. */
export function weekStartIST(now = new Date()) {
  const today = startOfTodayIST(now);
  return addDays(today, -((istParts(now).wd + 6) % 7));
}
export const nextWeekStartIST = (now = new Date()) => addDays(weekStartIST(now), 7);

/** Today's date and weekday in India time, for the system prompt. */
export const todayLine = (now = new Date()) => fullDate(now);

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A due date as the model wrote it: YYYY-MM-DD, or a relative phrase the server resolves.
 * Relative phrases mean the next occurrence AFTER today in India time (so "Monday" on a Monday is next Monday).
 * Returns the stored date (midnight IST) or throws a plain message the model can relay.
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
