import type { ZodType } from "zod";
import { ApiError } from "@/lib/http";
import {
  INVALID_VERSION, INVALID_VERSION_MESSAGE, VERSION_REQUIRED, VERSION_REQUIRED_MESSAGE,
} from "@/lib/version-error";

/**
 * APL-2669 / APL-2670: expectedUpdatedAt is the version.
 * Absent and null are missing. Every other value must be a full ISO 8601 date-time
 * with a time and a zone (Z or an offset). The caller compares the returned instant
 * with Date#getTime, not as a string.
 */
const ISO_DATE_TIME_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function classifyExpectedUpdatedAt(value: unknown): number {
  if (value === undefined || value === null) {
    throw new ApiError(400, VERSION_REQUIRED_MESSAGE, undefined, VERSION_REQUIRED);
  }
  if (typeof value !== "string" || !isIsoDateTimeWithZone(value)) {
    throw new ApiError(400, INVALID_VERSION_MESSAGE, undefined, INVALID_VERSION);
  }
  return Date.parse(value);
}

/** A real calendar date plus a clock time and a zone. */
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

/**
 * APL-2670 AC1 v1.4: after session and access, the version is checked before the body schema,
 * so a bad body with no version is version_required, not "Validation failed".
 */
export function versionFirst(raw: unknown): void {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).expectedUpdatedAt : undefined;
  classifyExpectedUpdatedAt(value);
}

/** parseBody for the version routes: valid JSON, then the version, then the schema. */
export async function parseVersionedBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Body must be valid JSON");
  }
  versionFirst(raw);
  return schema.parse(raw);
}
