// Bid cutoffs are distinct from date-only task due dates. Never infer an instant for a legacy date.
export type SubmissionDeadline = { submissionDeadline: string | null; submissionDeadlineAt?: string | null; submissionDeadlineZone?: string | null };
export type DeadlineChoice = "earlier" | "later";
export class DeadlineError extends Error {
  constructor(message: string, public choices?: string[]) { super(message); }
}
export const DEFAULT_DEADLINE_ZONE = "Asia/Kolkata";
export function validDeadlineZone(zone: string) {
  if (zone !== "UTC" && !/^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(zone)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}
function formatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function localStamp(f: Intl.DateTimeFormat, instant: number) {
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function resolveSubmissionDeadline(day: string, time: string, zone: string, choice?: DeadlineChoice) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new DeadlineError("Enter a valid submission date and time (HH:mm).");
  const stamp = `${day}T${time}:00`, wall = Date.parse(stamp + "Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== stamp) throw new DeadlineError("Enter a real submission date.");
  if (!validDeadlineZone(zone)) throw new DeadlineError("Choose a valid IANA timezone, such as Asia/Kolkata or America/New_York.");
  const f = formatter(zone), offsets = new Set<number>();
  // Sample both sides of a nearby transition, including date-line jumps. Verify every candidate by round-trip.
  for (let hours = -48; hours <= 48; hours += 6) {
    const t = wall + hours * 3600000;
    offsets.add(Date.parse(localStamp(f, t) + "Z") - t);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(t => localStamp(f, t) === stamp).sort((a, b) => a - b);
  if (!candidates.length) throw new DeadlineError("This local time does not exist in that timezone (clock change). Choose another time.");
  if (candidates.length > 1 && !choice) throw new DeadlineError("This local time occurs twice. Choose the earlier or later occurrence.", candidates.map(t => new Date(t).toISOString()));
  return new Date(choice === "later" ? candidates[candidates.length - 1] : candidates[0]);
}
export function submissionLocalTime(instant: string | Date | null | undefined, zone: string | null | undefined) {
  return instant && zone ? localStamp(formatter(zone), new Date(instant).getTime()).slice(11, 16) : null;
}
export function submissionDeadlineLabel(d: SubmissionDeadline) {
  if (!d.submissionDeadline) return "";
  if (!d.submissionDeadlineAt || !d.submissionDeadlineZone) return `${d.submissionDeadline} (date only)`;
  const instant = new Date(d.submissionDeadlineAt), zone = d.submissionDeadlineZone;
  const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(instant).find(p => p.type === "timeZoneName")?.value;
  return `${localStamp(formatter(zone), instant.getTime()).slice(0, 16).replace("T", " ")} ${zone} (${offset})`;
}
export function submissionDeadlinePassed(d: SubmissionDeadline, now = Date.now()) {
  if (d.submissionDeadlineAt) return new Date(d.submissionDeadlineAt).getTime() <= now;
  // Preserve the existing India-calendar overdue rule, without assigning midnight to the stored record.
  return !!d.submissionDeadline && d.submissionDeadline < new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
}
export function compareSubmissionDeadlines(a: SubmissionDeadline, b: SubmissionDeadline) {
  if (!a.submissionDeadline || !b.submissionDeadline) return a.submissionDeadline ? -1 : b.submissionDeadline ? 1 : 0;
  if (a.submissionDeadlineAt && b.submissionDeadlineAt) return Date.parse(a.submissionDeadlineAt) - Date.parse(b.submissionDeadlineAt);
  // Precision groups avoid inventing an instant for a date-only record, and keep ordering transitive.
  if (!!a.submissionDeadlineAt !== !!b.submissionDeadlineAt) return a.submissionDeadlineAt ? -1 : 1;
  return (a.submissionDeadline ?? "9999").localeCompare(b.submissionDeadline ?? "9999");
}
