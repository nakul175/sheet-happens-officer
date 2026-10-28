// SHO-2701: what the Activity screen offers on a row. The branch is on the row's `kind` - the action it was logged
// with - never on its `what` sentence: the sentence is prose and is free to be reworded. Pure, so the decision can be
// tested without a server or a browser, and so a copy edit cannot move it.
import { TASK_DELETED } from "@/lib/activity-text";

export type ActivityUndo = "available" | "undone" | "too_old" | "none";
export type ActivityRow = {
  id: string;
  ts: number;
  when: string;
  who: string;
  via: string;
  what: string;
  kind: string;
  undo: ActivityUndo;
};

/** What the decision needs: the kind, and the undo flag the server already worked out. */
type Branch = { kind?: string; undo: ActivityUndo };

/** A task delete is the kind `task.deleted`. Its sentence reads `moved "…" to Trash`, which is not the branch. */
export function isDeletedTaskRow(row: { kind?: string }) {
  return row.kind === TASK_DELETED;
}

/**
 * Undo on a delete follows Trash restore: only a Leader or an Admin (the project API reports both as LEADER).
 * Every other row keeps the feed's own undo flag. Hide the delete button until the role is known.
 */
export function showUndo(row: Branch, role: string | undefined) {
  if (row.undo !== "available") return false;
  if (isDeletedTaskRow(row) && role !== "LEADER") return false;
  return true;
}

/** AC6 v2.4: on a deleted-task row past the window, only whoever may restore (a Leader or Admin) sees "Too old to undo". */
export function showTooOld(row: Branch, role: string | undefined) {
  return row.undo === "too_old" && (!isDeletedTaskRow(row) || role === "LEADER");
}
