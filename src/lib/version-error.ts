// APL-2670: a missing task version is one error, whatever route received it.
// The field is expectedUpdatedAt (the updatedAt the person saw). Absent and null are
// "version_required". An empty string is malformed ("invalid_version"), not missing.
// A present value that is not the task's current updatedAt is "version_conflict".

export const VERSION_REQUIRED = "version_required";
export const INVALID_VERSION = "invalid_version";
export const VERSION_CONFLICT = "version_conflict";

export type VersionCode = typeof VERSION_REQUIRED | typeof INVALID_VERSION | typeof VERSION_CONFLICT;

export const VERSION_REQUIRED_MESSAGE = "expectedUpdatedAt is required";
export const INVALID_VERSION_MESSAGE = "expectedUpdatedAt is not a valid version";
export const VERSION_CONFLICT_MESSAGE = "This task changed while you were editing it.";

const CODES: readonly string[] = [VERSION_REQUIRED, INVALID_VERSION, VERSION_CONFLICT];

export function isVersionCode(code: unknown): code is VersionCode {
  return typeof code === "string" && CODES.includes(code);
}

/**
 * What is wrong with the version on a JSON body, or null when a value is present.
 * Only absent, null and "" are decided here. Other malformed values are left for the schema.
 */
export function versionProblem(body: unknown): typeof VERSION_REQUIRED | typeof INVALID_VERSION | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return VERSION_REQUIRED;
  if (!Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")) return VERSION_REQUIRED;
  const value = (body as Record<string, unknown>).expectedUpdatedAt;
  if (value === null || value === undefined) return VERSION_REQUIRED;
  if (value === "") return INVALID_VERSION;
  return null;
}

/** The only JSON body a version error may use: { error: { code, message } }. */
export function versionErrorBody(code: VersionCode, message: string) {
  return { error: { code, message } };
}
