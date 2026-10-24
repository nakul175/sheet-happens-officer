/** Submission dates retain date-only precision; timed deadlines are explicit instants displayed in IST. */
export const SUBMISSION_TIME_ZONE = "Asia/Kolkata";
export const SUBMISSION_TIME_ZONE_LABEL = "IST (UTC+05:30)";
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMED = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
function validDay(value: string) {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function parseSubmissionDeadline(value: string | null) {
  if (value === null) return { deadline: null, hasTime: false };
  if (validDay(value)) return { deadline: new Date(`${value}T00:00:00.000Z`), hasTime: false };
  const match = TIMED.exec(value);
  if (!match || !validDay(match[1]) || /[+-]14:(?!00)/.test(match[6])) throw new Error("Use a valid submission date, with an optional time and timezone.");
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime())) throw new Error("Use a valid submission date and time.");
  return { deadline, hasTime: true };
}
export function serializeSubmissionDeadline(value: Date | null | undefined, hasTime = false): string | null {
  return value ? hasTime ? value.toISOString() : value.toISOString().slice(0, 10) : null;
}
/** Input values for separate HTML date/time controls. No browser/host timezone dependence. */
export function submissionDeadlineFields(value: string | null | undefined) {
  if (!value) return { date: "", time: "" };
  if (validDay(value)) return { date: value, time: "" };
  const { deadline } = parseSubmissionDeadline(value);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SUBMISSION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(deadline!);
  const at = (type: string) => parts.find(part => part.type === type)!.value;
  return { date: `${at("year")}-${at("month")}-${at("day")}`, time: `${at("hour")}:${at("minute")}` };
}
export function submissionDeadlineInput(date: string, time: string): string | null {
  if (!date && !time) return null;
  if (!date || !validDay(date)) throw new Error("Choose a valid submission date before adding a time.");
  if (!time) return date;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a valid submission time.");
  const value = `${date}T${time}:00+05:30`;
  parseSubmissionDeadline(value);
  return value;
}
export function submissionDeadlineLabel(value: string | null | undefined) {
  const { date, time } = submissionDeadlineFields(value);
  return time ? `${date} at ${time} IST` : date;
}
/** Date-only means the whole IST calendar day; timed values expire at their exact instant. */
export function submissionDeadlineSortValue(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  return validDay(value) ? Date.parse(`${value}T23:59:59.999+05:30`) : parseSubmissionDeadline(value).deadline!.getTime();
}
export const submissionDeadlineOverdue = (value: string | null | undefined, now = Date.now()) => !!value && submissionDeadlineSortValue(value) < now;
/** Minute controls must not silently round an unchanged API deadline's seconds or milliseconds. */
export function submissionDeadlineEdit(original: string | null | undefined, date: string, time: string) {
  const initial = submissionDeadlineFields(original);
  return initial.date === date && initial.time === time ? original ?? null : submissionDeadlineInput(date, time);
}
