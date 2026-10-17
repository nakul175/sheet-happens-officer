import { activeMember, leaderId, type Tx } from "@/lib/access";
import { logAction, notify } from "@/lib/notify";

/**
 * A person stops holding work in a project: removed, deactivated, or moved to Viewer.
 * Nothing is ever left without an assignee (SHO-US-3.3, 3.4, 2.4, 4.6 AC8):
 *  - tasks they were approver on go to the project Leader (the Leader also becomes the holder
 *    if the task was awaiting approval; if the Leader is already the assignee, the approver is cleared);
 *  - their other open tasks and subtasks go to `newAssigneeId`;
 *  - they are dropped as collaborator unless `keepCollaborations` (a Viewer may collaborate).
 */
export type Released = {
  moved: number;
  approverTasks: number;
  cleared: number;
  dropped: number;
  /** What the person who left should be told, for their own removal or role notice. */
  note: { handedOver: string[]; handedOverCount: number; droppedCount: number };
};

export async function releasePerson(
  tx: Tx,
  o: { projectId: string; userId: string; newAssigneeId: string; actorId: string; keepCollaborations?: boolean },
): Promise<Released> {
  const leader = await leaderId(tx, o.projectId);
  const open = { projectId: o.projectId, completedAt: null, deletedAt: null };

  // 1. Approver duties.
  const asApprover = await tx.task.findMany({ where: { projectId: o.projectId, approverId: o.userId, deletedAt: null, completedAt: null } });
  let cleared = 0;
  for (const t of asApprover) {
    if (t.assigneeId === o.userId) {
      await tx.task.update({ where: { id: t.id }, data: { approverId: leader, assigneeId: leader } }); // awaiting approval
    } else if (t.assigneeId === leader) {
      await tx.task.update({ where: { id: t.id }, data: { approverId: null } });
      cleared++;
    } else {
      await tx.task.update({ where: { id: t.id }, data: { approverId: leader } });
    }
  }
  // Closed or trashed tasks keep a valid approver too.
  await tx.task.updateMany({ where: { projectId: o.projectId, approverId: o.userId }, data: { approverId: leader } });
  if (asApprover.length) {
    await logAction(tx, {
      actorId: o.actorId, projectId: o.projectId, targetType: "member", targetId: o.userId, action: "tasks.approver_reassigned",
      before: { approverId: o.userId, taskIds: asApprover.map((t) => t.id) }, after: { approverId: leader, cleared }, primary: false,
    });
  }

  // 2. Open work they are assigned.
  const mine = await tx.task.findMany({ where: { ...open, assigneeId: o.userId }, select: { id: true, title: true } });
  if (mine.length) {
    await tx.task.updateMany({ where: { id: { in: mine.map((t) => t.id) } }, data: { assigneeId: o.newAssigneeId } });
    await logAction(tx, {
      actorId: o.actorId, projectId: o.projectId, targetType: "member", targetId: o.userId, action: "tasks.reassigned",
      before: { assigneeId: o.userId, taskIds: mine.map((t) => t.id) }, after: { assigneeId: o.newAssigneeId, count: mine.length }, primary: false,
    });
  }

  // 3. Collaborations.
  let dropped = 0;
  if (!o.keepCollaborations) {
    const rows = await tx.taskCollaborator.findMany({ where: { userId: o.userId, task: { projectId: o.projectId } }, select: { taskId: true } });
    if (rows.length) {
      await tx.taskCollaborator.deleteMany({ where: { userId: o.userId, task: { projectId: o.projectId } } });
      dropped = rows.length;
      await logAction(tx, {
        actorId: o.actorId, projectId: o.projectId, targetType: "member", targetId: o.userId, action: "tasks.collaborations_dropped",
        before: { userId: o.userId, taskIds: rows.map((r) => r.taskId) }, after: { count: rows.length }, primary: false,
      });
    }
  }

  // 4. One notice per person who needs to know: the new owner, and the Leader (who also hears about approvers).
  const moved = mine.length;
  if (moved || asApprover.length) {
    const [from, to] = await Promise.all([
      tx.user.findUnique({ where: { id: o.userId }, select: { name: true } }),
      tx.user.findUnique({ where: { id: o.newAssigneeId }, select: { name: true } }),
    ]);
    const base = { fromName: from?.name ?? "A person", approver: asApprover.length, cleared };
    if (o.newAssigneeId === leader) {
      await notify(tx, [leader], "TASKS_HANDED_OVER", {
        actorId: o.actorId, projectId: o.projectId, includeActor: !!asApprover.length,
        data: { ...base, moved, toYou: true },
      });
    } else {
      if (moved) await notify(tx, [o.newAssigneeId], "TASKS_HANDED_OVER", {
        actorId: o.actorId, projectId: o.projectId, data: { fromName: base.fromName, approver: 0, cleared: 0, moved, toYou: true },
      });
      await notify(tx, [leader], "TASKS_HANDED_OVER", {
        actorId: o.actorId, projectId: o.projectId, includeActor: !!asApprover.length,
        data: { ...base, moved, toYou: false, to: to?.name ?? "someone else" },
      });
    }
  }
  return {
    moved,
    approverTasks: asApprover.length,
    cleared,
    dropped,
    note: { handedOver: moved < 5 ? mine.map((t) => t.title) : [], handedOverCount: moved, droppedCount: dropped },
  };
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
