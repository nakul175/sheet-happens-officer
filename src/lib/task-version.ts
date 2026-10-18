import { ApiError } from "@/lib/http";

/**
 * APL-2669 v1.3: the task edit token is expectedUpdatedAt, an ISO 8601 date-time
 * with a time and a zone (Z or an offset). Date-only values, zone-less values,
 * empty strings, and anything that is not that shape are a bad request.
 * A missing token is refused separately, with the same message the other
 * task mutations already use.
 */
const ISO_DATE_TIME_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function classifyExpectedUpdatedAt(value: unknown): number {
  if (value === undefined) throw new ApiError(400, "expectedUpdatedAt is required");
  if (typeof value !== "string" || !isIsoDateTimeWithZone(value)) {
    throw new ApiError(400, "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone.", {
      code: "invalid_version",
    });
  }
  return Date.parse(value);
}

/** A real calendar date plus a clock time and a zone. Compared later as an instant. */
function isIsoDateTimeWithZone(value: string): boolean {
  const m = ISO_DATE_TIME_WITH_ZONE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  return !Number.isNaN(Date.parse(value));
}
