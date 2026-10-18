// SHO-BUG-9 (APL-2643): the badge paints "99+" once the count passes 99. The spoken name
// has to contain that same text, or WCAG 2.5.3 Label in Name fails (axe: label-content-name-mismatch).

/** The count painted on the bell. Null when there is nothing unread, so no stale number is shown. */
export function bellBadge(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/** Accessible name. With unread notices it includes the visible badge; with none it is the plain label. */
export function bellName(unread: number): string {
  const badge = bellBadge(unread);
  return badge ? `Notifications, ${badge} unread` : "Notifications";
}
