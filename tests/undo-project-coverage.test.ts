import { describe, expect, it } from "vitest";
import { projectUndoIsTransactional } from "@/lib/undo";
import { recordUndoIsTransactional } from "@/lib/records";
import { UNDO_LABELS } from "@/lib/undoable";

const RECORD_PREFIXES = ["organisation.", "contact.", "note."];

describe("project Undo transaction coverage", () => {
  it("requires every published project action to use the locked inverse path", () => {
    const projectActions = Object.keys(UNDO_LABELS).filter(
      (action) => !RECORD_PREFIXES.some((prefix) => action.startsWith(prefix)),
    );
    expect(projectActions.length).toBeGreaterThan(0);
    expect(projectActions.filter((action) => !projectUndoIsTransactional(action))).toEqual([]);
  });

  it("does not classify record actions or an unknown action as project inverses", () => {
    for (const action of Object.keys(UNDO_LABELS).filter(
      (candidate) => RECORD_PREFIXES.some((prefix) => candidate.startsWith(prefix)),
    )) expect(projectUndoIsTransactional(action)).toBe(false);
    expect(projectUndoIsTransactional("future.unknown")).toBe(false);
  });

  it("requires every published record action to use a locked inverse path", () => {
    const recordActions = Object.keys(UNDO_LABELS).filter(
      (action) => RECORD_PREFIXES.some((prefix) => action.startsWith(prefix)),
    );
    expect(recordActions.length).toBeGreaterThan(0);
    expect(recordActions.filter((action) => !recordUndoIsTransactional(action))).toEqual([]);
    expect(recordUndoIsTransactional("future.unknown")).toBe(false);
  });
});
