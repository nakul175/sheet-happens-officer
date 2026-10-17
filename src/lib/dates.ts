// Due dates are calendar dates in India. They are stored as midnight IST and shown as YYYY-MM-DD.
const IST_MS = 5.5 * 3600_000;
const DAY = 86400_000;

export const parseDueDate = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) - IST_MS);
export const formatDueDate = (d: Date | null) => (d ? new Date(d.getTime() + IST_MS).toISOString().slice(0, 10) : null);

/** Midnight at the start of today in IST, as an instant. */
export function startOfTodayIST(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS);
}
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
