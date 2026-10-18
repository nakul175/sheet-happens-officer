// APL-2672: the Unread tab listed read rows. Marking a notice read reloads All, and that
// response can land after the Unread fetch (or after the tab has already changed) and paint
// the full list. The API's filter=unread is already correct; the panel must ignore a stale
// page and must not render a read row while Unread is selected.

export type BellFilter = "all" | "unread";

/** A load may update the panel only when it is still the latest one and still the open tab. */
export function responseApplies(fetched: BellFilter, current: BellFilter, mine: number, latest: number): boolean {
  return fetched === current && mine === latest;
}

/** Rows to paint. Unread drops read notices, including ones left over from an All page. */
export function visibleNotes<T extends { read: boolean }>(filter: BellFilter, items: T[]): T[] {
  return filter === "unread" ? items.filter((n) => !n.read) : items;
}

/** Empty copy. Nothing left on Unread is "All caught up". */
export function bellEmptyText(filter: BellFilter): string {
  return filter === "unread" ? "All caught up" : "No notifications yet.";
}
