/** A move-to-Monday fixture must not already be due on that Monday.
 * Use the Sunday before the next Monday (including today when it is Sunday), in India time.
 * This is explicit fixture setup only: production dates and no-op refusal stay unchanged.
 */
export function dueBeforeNextMonday(now = new Date()) {
  const local = new Date(now.getTime() + 5.5 * 3600_000);
  const daysToSunday = (7 - local.getUTCDay()) % 7;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysToSunday)).toISOString().slice(0, 10);
}
