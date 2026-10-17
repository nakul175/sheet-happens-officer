import { activeMember, leaderId, type Tx } from "@/lib/access";
import { notify } from "@/lib/notify";

/**
 * A person stops holding work in a project: removed, deactivated, or moved to Viewer.
 * Nothing is ever left without an assignee (SHO-US-3.3, 3.4, 2.4, 4.6 AC8):
 *  - tasks they were approver on go to the project Leader (the Leader also becomes the holder
 *    if the task was awaiting approval; if the Leader is already the assignee, the approver is cleared);
 *  - their other open tasks and subtasks go to `newAssigneeId`;
 *  - they are dropped as collaborator unless `keepCollaborations` (a Viewer may collaborate).
 */
export async function releasePerson(
  tx: Tx,
  o: { projectId: string; userId: string; newAssigneeId: string; actorId: string; keepCollaborations?: boolean },
) {
  const leader = await leaderId(tx, o.projectId);
  const open = { projectId: o.projectId, completedAt: null, deletedAt: null };

  // 1. Approver duties.
  const asApprover = await tx.task.findMany({ where: { projectId: o.projectId, approverId: o.userId, deletedAt: null, completedAt: null } });
  for (const t of asApprover) {
    if (t.assigneeId === o.userId) {
      await tx.task.update({ where: { id: t.id }, data: { approverId: leader, assigneeId: leader } }); // awaiting approval
    } else if (t.assigneeId === leader) {
      await tx.task.update({ where: { id: t.id }, data: { approverId: null } });
    } else {
      await tx.task.update({ where: { id: t.id }, data: { approverId: leader } });
    }
  }
  // Closed or trashed tasks keep a valid approver too.
  await tx.task.updateMany({ where: { projectId: o.projectId, approverId: o.userId }, data: { approverId: leader } });

  // 2. Open work they are assigned.
  const mine = await tx.task.findMany({ where: { ...open, assigneeId: o.userId }, select: { id: true } });
  if (mine.length) {
    await tx.task.updateMany({ where: { id: { in: mine.map((t) => t.id) } }, data: { assigneeId: o.newAssigneeId } });
  }

  // 3. Collaborations.
  if (!o.keepCollaborations) {
    await tx.taskCollaborator.deleteMany({ where: { userId: o.userId, task: { projectId: o.projectId } } });
  }

  const moved = mine.length;
  if (moved) {
    await notify(tx, [o.newAssigneeId], "TASKS_REASSIGNED", {
      actorId: o.actorId,
      projectId: o.projectId,
      data: { count: moved, fromUserId: o.userId },
    });
  }
  if (asApprover.length) {
    await notify(tx, [leader], "APPROVER_REASSIGNED", {
      actorId: o.actorId,
      projectId: o.projectId,
      data: { count: asApprover.length, fromUserId: o.userId },
    });
  }
  return { moved, approverTasks: asApprover.length };
}

export async function openTaskCount(tx: Tx, projectId: string, userId: string) {
  return tx.task.count({ where: { projectId, assigneeId: userId, completedAt: null, deletedAt: null } });
}

/** Validates a handover target: an active Leader or Editor of the project, and not the person leaving. */
export async function resolveHandover(tx: Tx, projectId: string, leavingId: string, handoverTo?: string | null) {
  if (!handoverTo || handoverTo === leavingId) return null;
  const m = await activeMember(tx, projectId, handoverTo, ["LEADER", "EDITOR"]);
  return m ? m.userId : null;
}
