// APL-2672 (SHO-US-14.13 AC3): Unread lists no read rows, and an empty unread list says "All caught up".
import { describe, expect, it } from "vitest";
import { bellEmptyText, responseApplies, visibleNotes, type BellFilter } from "@/app/(app)/bell-list";

type Note = { id: string; read: boolean };

const mixed: Note[] = [
  { id: "new", read: false },
  { id: "seen-1", read: true },
  { id: "seen-2", read: true },
];

/** Same class the staging check counts: a row without `.unread` is a read row. */
function readRowCount(filter: BellFilter, items: Note[]): number {
  return visibleNotes(filter, items).filter((n) => n.read).length;
}

describe("notification Unread filter (APL-2672)", () => {
  it("lists only unread items, so the Unread tab has no read rows", () => {
    const shown = visibleNotes("unread", mixed);
    expect(shown.map((n) => n.id)).toEqual(["new"]);
    expect(shown.every((n) => !n.read)).toBe(true);
    expect(readRowCount("unread", mixed)).toBe(0);
    // All still shows the read ones.
    expect(visibleNotes("all", mixed)).toEqual(mixed);
  });

  it("says All caught up when nothing unread remains", () => {
    const readOnly = mixed.filter((n) => n.read);
    expect(visibleNotes("unread", readOnly)).toEqual([]);
    expect(readRowCount("unread", readOnly)).toBe(0);
    expect(bellEmptyText("unread")).toBe("All caught up");
    expect(bellEmptyText("all")).toBe("No notifications yet.");
  });

  it("drops a late All refresh once Unread is the open tab", () => {
    // Mark-read starts an All reload (generation 1). Switching to Unread starts generation 2.
    // Whichever body returns last, All must not replace the Unread page.
    expect(responseApplies("all", "unread", 1, 2)).toBe(false);
    expect(responseApplies("all", "unread", 2, 2)).toBe(false);
    expect(responseApplies("unread", "unread", 1, 2)).toBe(false);
    expect(responseApplies("unread", "unread", 2, 2)).toBe(true);
    // The page that does apply, filtered for the tab, still has no read rows.
    const page = visibleNotes("unread", mixed);
    expect(readRowCount("unread", page)).toBe(0);
    expect(visibleNotes("unread", page.filter((n) => n.read))).toEqual([]);
    expect(bellEmptyText("unread")).toBe("All caught up");
  });
});
