import { returnToEnabled, safeReturnPath } from "@/lib/return-to";

/** Only the first-party authorization endpoint may resume a suite handoff. */
export function suiteReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/api/suite/authorize?")) return null;
  if (/[\u0000-\u0020\u007f\\#]/.test(value)) return null;
  const parsed = new URL(value, "https://sho.invalid");
  return parsed.origin === "https://sho.invalid" && parsed.pathname === "/api/suite/authorize" ? value : null;
}
export function signInDestination(next: string | undefined, returnTo: unknown): string {
  return suiteReturnPath(returnTo) ?? (returnToEnabled() ? (safeReturnPath(next, 1) ?? "/") : "/");
}
