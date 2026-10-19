// APL-2669 / APL-2670: every task-version answer uses one body, { error: { code, message } }.
// The token is expectedUpdatedAt. Absent and null are version_required. Anything that is
// not a full ISO 8601 date-time with a zone is invalid_version. A different instant is
// version_conflict. A missing task is not_found. A hidden project stays 404 { error: "Project not found" }.

export const VERSION_REQUIRED = "version_required";
export const INVALID_VERSION = "invalid_version";
export const VERSION_CONFLICT = "version_conflict";
export const NOT_FOUND = "not_found";

export type VersionCode = typeof VERSION_REQUIRED | typeof INVALID_VERSION | typeof VERSION_CONFLICT | typeof NOT_FOUND;

export const VERSION_REQUIRED_MESSAGE = "expectedUpdatedAt is required";
export const INVALID_VERSION_MESSAGE = "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone.";
/** The name stays inside the message. APL-2670 allows no other keys on the body. */
export function versionConflictMessage(name: string | null | undefined) {
  const who = name?.trim() ? name.trim() : "Someone";
  return `${who} changed this task while you were editing it.`;
}

const CONFLICT_SUFFIX = " changed this task while you were editing it.";

/** The person named by a version_conflict message. */
export function conflictActor(error: unknown) {
  const message = errorMessage(error, versionConflictMessage(null));
  return message.endsWith(CONFLICT_SUFFIX) ? message.slice(0, -CONFLICT_SUFFIX.length) : "Someone";
}
export const NOT_FOUND_MESSAGE = "Task not found";

const CODES: readonly string[] = [VERSION_REQUIRED, INVALID_VERSION, VERSION_CONFLICT, NOT_FOUND];

export function isVersionCode(code: unknown): code is VersionCode {
  return typeof code === "string" && CODES.includes(code);
}

/** The only JSON body a version error may use. No sibling keys, and none inside error. */
export function versionErrorBody(code: VersionCode, message: string) {
  return { error: { code, message } };
}

/** A stale edit is 409 version_conflict. Older answers set data.stale instead. */
export function isVersionConflict(status: number, data: { stale?: unknown; error?: unknown } | null | undefined) {
  if (status !== 409 || !data) return false;
  if (data.stale === true) return true;
  const error = data.error;
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === VERSION_CONFLICT;
}

/**
 * api() leaves data.error as-is. A version error stores { code, message } there, so a screen
 * that wants a sentence has to read it. Other errors are still a string.
 */
export function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return fallback;
}
