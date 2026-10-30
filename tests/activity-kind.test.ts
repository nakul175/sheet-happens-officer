import { describe, expect, it } from "vitest";
import { showTooOld, showUndo } from "@/app/(app)/projects/[id]/activity/Activity";

describe("SHO-2701 Activity event kind", () => {
  for (const what of ['deleted "Invoice"', 'चालान ट्रैश में भेजा', ""]) {
    it(`keeps delete controls role-gated after wording changes: ${what}`, () => {
      const row = { kind: "task.deleted", what, undo: "available" as const };
      expect(showUndo(row, "EDITOR")).toBe(false);
      expect(showUndo(row, undefined)).toBe(false);
      expect(showUndo(row, "LEADER")).toBe(true);
      expect(showTooOld({ ...row, undo: "too_old" }, "EDITOR")).toBe(false);
      expect(showTooOld({ ...row, undo: "too_old" }, "LEADER")).toBe(true);
    });
  }
  it("does not classify a non-delete by its display sentence", () => {
    const row = { kind: "task.moved", what: 'moved "Invoice" to Trash', undo: "available" as const };
    expect(showUndo(row, "EDITOR")).toBe(true);
    expect(showTooOld({ ...row, undo: "too_old" }, "EDITOR")).toBe(true);
  });
  it("still respects the feed's unavailable and undone flags", () => {
    for (const undo of ["none", "undone", "too_old"] as const) {
      expect(showUndo({ kind: "task.deleted", undo }, "LEADER")).toBe(false);
    }
    expect(showTooOld({ kind: "task.deleted", undo: "undone" }, "LEADER")).toBe(false);
  });
});
