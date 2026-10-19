// APL-2670: a missing expectedUpdatedAt is one error, whatever mutation route received it.
// The token stays the ISO timestamp the person saw (no integer version field; that is APL-2668).
// Checks run session, then access, then this value, then the rest of the body.
// Absent and null are "version_required". "" and any other non-ISO value are
// "invalid_version". A real ISO timestamp that is not the task's current updatedAt
// is "version_conflict". A task the caller cannot see is "not_found", same as an unknown id.

export const VERSION_REQUIRED = "version_required";
export const INVALID_VERSION = "invalid_version";
export const VERSION_CONFLICT = "version_conflict";
export const NOT_FOUND = "not_found";

export type VersionCode = typeof VERSION_REQUIRED | typeof INVALID_VERSION | typeof VERSION_CONFLICT;

export const VERSION_REQUIRED_MESSAGE = "expectedUpdatedAt is required";
export const INVALID_VERSION_MESSAGE = "expectedUpdatedAt is not a valid version";
export const VERSION_CONFLICT_MESSAGE = "This task changed while you were editing it.";

const CODES: readonly string[] = [VERSION_REQUIRED, INVALID_VERSION, VERSION_CONFLICT];

/** The form Date.toISOString() produces, plus an offset. Not a date-only string. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isVersionCode(code: unknown): code is VersionCode {
  return typeof code === "string" && CODES.includes(code);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

/** Absent or null is missing. Anything else that is not an ISO timestamp is malformed. A valid timestamp is null. */
export function classifyVersionValue(value: unknown): typeof VERSION_REQUIRED | typeof INVALID_VERSION | null {
  if (value === undefined || value === null) return VERSION_REQUIRED;
  if (!isIsoTimestamp(value)) return INVALID_VERSION;
  return null;
}

/**
 * What is wrong with expectedUpdatedAt on a JSON body, or null when a real ISO timestamp is present.
 */
export function versionProblem(body: unknown): typeof VERSION_REQUIRED | typeof INVALID_VERSION | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return VERSION_REQUIRED;
  if (!Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")) return VERSION_REQUIRED;
  return classifyVersionValue((body as Record<string, unknown>).expectedUpdatedAt);
}

/** The only JSON body these errors may use: { error: { code, message } }. */
export function versionErrorBody(code: string, message: string) {
  return { error: { code, message } };
}
