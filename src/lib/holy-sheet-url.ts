/** A document reference is never an HS permission grant. Only reviewed origins are accepted. */
const APPROVED_HOLY_SHEET_ORIGINS = new Set([
  "https://staging.holysheet.aplyd.org",
  "https://holysheet.aplyd.org",
]);

export function isApprovedHolySheetOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && APPROVED_HOLY_SHEET_ORIGINS.has(origin);
}

export function holySheetOrigin(env: Record<string, string | undefined> = process.env) {
  if (env.FF_HOLY_SHEET !== "1") return null;
  const origin = env.HOLY_SHEET_ORIGIN;
  return isApprovedHolySheetOrigin(origin) ? origin : null;
}

export function holySheetDocumentId(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
    return /^\/pages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}
