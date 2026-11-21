// Keep job failures useful to operators without retaining or rendering raw exception messages.
const SQLSTATE = /^(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3}$/;
const DISPLAYABLE = /^(?:P\d{4}(?:\/(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3})?|(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3}|UNKNOWN) \([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;

export function jobFailureCategory(err: unknown) {
  const code = (err as { code?: unknown } | null)?.code;
  const metaCode = (err as { meta?: { code?: unknown } } | null)?.meta?.code;
  if (typeof code === "string" && /^P\d{4}$/.test(code)) {
    return code === "P2010" && typeof metaCode === "string" && SQLSTATE.test(metaCode) ? `${code}/${metaCode}` : code;
  }
  return typeof code === "string" && SQLSTATE.test(code) ? code : "UNKNOWN";
}

export function displayedJobFailure(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" && DISPLAYABLE.test(value) ? value : "Earlier failure; details withheld";
}
