/**
 * Screen rules for a task that has an approver (APL-2660).
 * The board and the task detail use these so a person who may not close a task
 * is not offered Close, a complete tick, a drop into Done, or Done in Move to….
 */

/** The "Close task" button on the task detail. */
export function closeControlOffered(o: { canEdit: boolean; done: boolean; canClose: boolean }) {
  return o.canEdit && !o.done && o.canClose;
}

/** The complete tick on the list and the board. Reopen stays available on a finished task. */
export function completeTickAllowed(o: { canWrite: boolean; canClose: boolean; completedAt: string | null }) {
  return o.canWrite && (o.canClose || !!o.completedAt);
}

/** A card may be dropped on Done only by someone who may close it (an already-complete card may move back). */
export function canDropOnSection(
  task: { canClose: boolean; completedAt: string | null } | undefined,
  sectionIsDone: boolean,
) {
  if (!sectionIsDone) return true;
  return !!task && (task.canClose || !!task.completedAt);
}

/** Move to… omits the Done section for a person who may not close the task. */
export function moveMenuSections<T extends { id: string; isDone: boolean }>(
  sections: T[],
  task: { canClose: boolean; sectionId: string },
) {
  return sections.filter((s) => !s.isDone || task.canClose || s.id === task.sectionId);
}
