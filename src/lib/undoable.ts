// Which project actions Undo can reverse, and what to call them (SHO-US-6.4).
export const UNDO_LABELS: Record<string, string> = {
  "task.created": "Task created",
  "task.updated": "Task edited",
  "task.assigned": "Task reassigned",
  "task.collaborator_added": "Collaborator added",
  "task.collaborator_removed": "Collaborator removed",
  "task.approver_changed": "Approver changed",
  "task.sent_for_approval": "Task sent for approval",
  "task.sent_back": "Task sent back",
  "task.completed": "Task completed",
  "task.reopened": "Task reopened",
  "task.moved": "Task moved",
  "task.deleted": "Task deleted",
  "task.restored": "Task restored",
  "project.updated": "Project edited",
  "project.archived": "Project archived",
  "project.unarchived": "Project unarchived",
  "project.leader_changed": "Leader changed",
  "member.added": "Member added",
  "member.removed": "Member removed",
  "member.role_changed": "Role changed",
  "section.added": "Section added",
  "section.renamed": "Section renamed",
  "section.moved": "Section moved",
  "section.done_changed": "Done section changed",
  "deal.stage_changed": "Stage changed",
  "deal.details_updated": "Deal details edited",
  "deal.converted": "Task converted to a deal",
  "organisation.created": "Organisation added",
  "organisation.updated": "Organisation edited",
  "organisation.archived": "Organisation archived",
  "organisation.unarchived": "Organisation unarchived",
  "contact.created": "Contact added",
  "contact.updated": "Contact edited",
  "contact.removed": "Contact removed",
  "note.created": "Note added",
  "note.removed": "Note deleted",
  "comment.added": "Comment added",
  "comment.removed": "Comment deleted",
  "task.idea_changed": "Idea flag changed",
  "task.link_added": "Link added",
  "task.link_removed": "Link removed",
};
export const isUndoable = (action: string) => action in UNDO_LABELS;
export const UNDO_DAYS = 30;
/** 30 × 24 hours. Exactly this age is still undoable; only a greater age is too old (APL-2711). */
export const UNDO_WINDOW_MS = UNDO_DAYS * 86_400_000;

/**
 * True when `at` is strictly older than 30×24h. Exactly 30 days still counts as undoable.
 * `at` is a Date or epoch ms: the concierge paths keep epoch ms (APL-2717), the rest pass Dates (APL-2711).
 * The comment purge uses it too: a soft-deleted comment at exactly 30×24h is kept (APL-2590).
 */
export function isTooOldToUndo(at: Date | number, now = Date.now()): boolean {
  return now - (typeof at === "number" ? at : at.getTime()) > UNDO_WINDOW_MS;
}

/** Trash with `deletedAt` strictly before this instant is past the undo window. */
export function trashPurgeBefore(now: Date | number = Date.now()): Date {
  const t = typeof now === "number" ? now : now.getTime();
  return new Date(t - UNDO_WINDOW_MS);
}
