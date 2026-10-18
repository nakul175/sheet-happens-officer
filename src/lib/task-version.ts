import { ApiError } from "@/lib/http";

/**
 * APL-2669: the only well-formed task version is a positive integer.
 * Strings (including "3" and " 3 "), zero, negatives, fractions, overflow,
 * booleans, arrays and objects are a bad request. Absent and null are missing.
 */
export function classifyTaskVersion(value: unknown): number {
  if (value === undefined || value === null) {
    throw new ApiError(400, "A version is required.", { code: "version_required" });
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new ApiError(400, "Version must be a positive integer.", { code: "invalid_version" });
}
