// SHO-US-14.5 AC3: "tomorrow", "fri", "in 3 days" or 2026-10-30 become a calendar date (India time).
// Pure, so the quick-add box can show the date before saving and tests can run without a server.
import { resolveDue, WEEKDAYS } from "@/lib/relative-dates";
import { formatDueDate } from "@/lib/dates";

const SHORT: Record<string, string> = { sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday" };

/** The date as YYYY-MM-DD, or null when the words are not a date. An empty box is "no date" and returns null too. */
export function wordsToDate(input: string, now = new Date()): string | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;
  const m = /^((?:next|this|on)\s+)?([a-z]+)$/.exec(raw);
  const fixed = m && SHORT[m[2]] ? `${m[1] ?? ""}${SHORT[m[2]]}` : raw;
  try { return formatDueDate(resolveDue(fixed, now)); } catch { return null; }
}

/** "Fri 23 Oct" for a YYYY-MM-DD date. */
export function dateLabel(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}
