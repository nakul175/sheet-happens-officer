// The eval clock is Monday 17 March 2031, 10:00 India time: the same instant as MONDAY in tests/concierge-helpers.ts.
// Relative dates in prompts are graded against what the server resolves for the person's own words.
import { formatDueDate, startOfTodayIST, addDays, parseDueDate } from "../../src/lib/dates";
import { resolveDue } from "../../src/lib/concierge/dates";

export const EVAL_NOW = new Date(Date.UTC(2031, 2, 17, 4, 30));

const phrase = (words: string) => {
  const d = formatDueDate(resolveDue(words, EVAL_NOW));
  if (!d) throw new Error(`could not resolve ${words}`);
  return d;
};

export const DUE = {
  today: phrase("today"),
  tomorrow: phrase("tomorrow"),
  monday: phrase("monday"),
  nextWeek: phrase("next week"),
  endOfWeek: phrase("end of week"),
  endOfMonth: phrase("end of month"),
  in3Days: phrase("in 3 days"),
};

/** A fixture due word or YYYY-MM-DD, as the timestamp stored on a task. */
export function fixtureDue(spec: string | undefined): Date | null {
  if (!spec || spec === "none") return null;
  const today = startOfTodayIST(EVAL_NOW);
  if (spec === "overdue") return addDays(today, -4);
  if (spec === "soon") return addDays(today, 2);
  if (spec === "later") return addDays(today, 40);
  if (spec === "today") return today;
  if (spec === "tomorrow") return addDays(today, 1);
  return parseDueDate(spec);
}
