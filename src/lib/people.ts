import { WORKERS, activeMember, leaderId, type Tx } from "@/lib/access";
import { ApiError } from "@/lib/http";
import { logAction, notify } from "@/lib/notify";

/**
 * A person stops holding work in a project: removed, deactivated, or moved to Viewer.
 * Nothing is ever left without an assignee (SHO-US-3.3, 3.4, 2.4, 4.6 AC8):
 *  - tasks they were approver on go to the project Leader (the Leader also becomes the holder
 *    if the task was awaiting approval; if the Leader is already the assignee, the approver is cleared);
 *  - their other open tasks and subtasks go to `newAssigneeId`, or each to the person named for it
 *    in `handover` (the concierge card's per-task choice, SHO-BUG-7), the rest to `newAssigneeId`;
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
/** Who takes one task when its holder leaves. */
export type Handover = { taskId: string; assigneeId: string };

/** "Asha", "Asha and Ravi", "Asha, Ravi and Dev". */
const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export async function releasePerson(
  tx: Tx,
  o: { projectId: string; userId: string; newAssigneeId: string; actorId: string; keepCollaborations?: boolean; handover?: Handover[] },
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

  // 2. Open work they are assigned: each task to the person named for it, the rest to `newAssigneeId`. One log row per new owner.
  const mine = await tx.task.findMany({ where: { ...open, assigneeId: o.userId }, select: { id: true, title: true } });
  const byOwner = new Map<string, string[]>();
  for (const t of mine) {
    const to = o.handover?.find((h) => h.taskId === t.id)?.assigneeId ?? o.newAssigneeId;
    byOwner.set(to, [...(byOwner.get(to) ?? []), t.id]);
  }
  for (const to of new Set(o.handover?.map((h) => h.assigneeId) ?? [])) {
    // The leaver is still a member at this point, so they are ruled out by name.
    if (byOwner.has(to) && (to === o.userId || !(await activeMember(tx, o.projectId, to, WORKERS)))) throw new ApiError(400, "Each task must go to an active Leader or Editor of this project.");
  }
  for (const [to, ids] of byOwner) {
    await tx.task.updateMany({ where: { id: { in: ids } }, data: { assigneeId: to } });
    await logAction(tx, {
      actorId: o.actorId, projectId: o.projectId, targetType: "member", targetId: o.userId, action: "tasks.reassigned",
      before: { assigneeId: o.userId, taskIds: ids }, after: { assigneeId: to, count: ids.length }, primary: false,
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

  // 4. One notice per person who needs to know: each new owner, and the Leader (who also hears about approvers).
  const moved = mine.length;
  if (moved || asApprover.length) {
    const owners = byOwner.size ? [...byOwner.keys()] : [o.newAssigneeId]; // nothing moved: the would-be taker, as before
    const people = await tx.user.findMany({ where: { id: { in: [o.userId, ...owners] } }, select: { id: true, name: true } });
    const nameOf = (id: string) => people.find((p) => p.id === id)?.name;
    const base = { fromName: nameOf(o.userId) ?? "A person", approver: asApprover.length, cleared };
    const elsewhere = owners.filter((to) => to !== leader);
    for (const to of elsewhere) {
      const n = byOwner.get(to)?.length ?? 0;
      if (n) await notify(tx, [to], "TASKS_HANDED_OVER", { actorId: o.actorId, projectId: o.projectId, data: { fromName: base.fromName, approver: 0, cleared: 0, moved: n, toYou: true } });
    }
    // The Leader hears the whole picture: what went elsewhere (and to whom), what came to them, and the approver duties.
    const toLeader = byOwner.get(leader)?.length ?? 0;
    await notify(tx, [leader], "TASKS_HANDED_OVER", {
      actorId: o.actorId, projectId: o.projectId, includeActor: !!asApprover.length,
      data: elsewhere.length
        ? { ...base, moved: moved - toLeader, toYou: false, to: listNames(elsewhere.map((to) => nameOf(to) ?? "someone else")), ...(toLeader ? { movedToYou: toLeader } : {}) }
        : { ...base, moved, toYou: true },
    });
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
