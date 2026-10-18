import { ensureNextStep } from "@/lib/deals";
import { crmProjectWhere } from "@/lib/crm";
import { linksOfTask } from "@/lib/records";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import {
  WORKERS, activeMember, canManage, leaderId, projectAccess, requireManage, requireWrite, type Actor, type Role, type Tx,
} from "@/lib/access";
import { addDays, formatDueDate, parseDueDate, startOfTodayIST } from "@/lib/dates";
import { auditTx, logAction, notify } from "@/lib/notify";
import { reqCtx } from "@/lib/reqctx";

export const taskInclude = {
  assignee: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  collaborators: { select: { user: { select: { id: true, name: true } } } },
  subtasks: { where: { deletedAt: null }, select: { id: true, completedAt: true } },
} as const;

type TaskRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
const loadRow = (id: string) => db.task.findUnique({ where: { id }, include: taskInclude });

/** SHO-US-14.1: a task waits for approval only while it is open; a closed task keeps its approver but is no longer waiting. */
export const awaiting = (t: { approverId: string | null; assigneeId: string; completedAt?: Date | null }) =>
  !!t.approverId && t.assigneeId === t.approverId && !t.completedAt;

/** Who may close a task (SHO-US-4.3 AC6, 4.6 AC4). With an approver only the approver, Leader or Admin. */
export function canClose(userId: string, role: Role, t: { approverId: string | null; assigneeId: string }) {
  if (role === "VIEWER") return false;
  if (t.approverId) return userId === t.approverId || role === "LEADER";
  return true;
}

export function present(t: TaskRow, viewer?: { id: string; role: Role }) {
  return {
    id: t.id,
    projectId: t.projectId,
    sectionId: t.sectionId,
    parentId: t.parentId,
    title: t.title,
    description: t.description,
    priority: t.priority,
    dueDate: formatDueDate(t.dueDate),
    blocked: t.blocked,
    blockedReason: t.blockedReason,
    isIdea: t.isIdea,
    completedAt: t.completedAt,
    assignee: t.assignee,
    approver: t.approver,
    collaborators: t.collaborators.map((c) => c.user),
    awaitingApproval: awaiting(t),
    previousAssigneeId: t.previousAssigneeId,
    createdById: t.createdById,
    subtasks: { total: t.subtasks.length, open: t.subtasks.filter((s) => !s.completedAt).length },
    updatedAt: t.updatedAt,
    ...(viewer ? { canClose: canClose(viewer.id, viewer.role, t) } : {}),
  };
}

async function loadTask(user: Actor, id: string, o: { write?: boolean; deleted?: boolean; holderCanDo?: boolean } = {}) {
  const t = await loadRow(id);
  if (!t || (t.deletedAt && !o.deleted)) throw notFound("Task");
  const a = await projectAccess(user, t.projectId, { write: o.write });
  if (o.write) requireWrite(a);
  // The approver holding a task can only Close it or Send it back (SHO-US-4.6); the Leader and Admins keep full authority.
  if (o.write && !o.holderCanDo && awaiting(t) && user.id === t.approverId && a.role !== "LEADER") {
    throw new ApiError(403, "While you hold this task for approval you can only close it or send it back.");
  }
  return { t, a };
}

export const ORDER = [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }] as const;

async function requireWorker(tx: Tx, projectId: string, userId: string, what: string) {
  const m = await activeMember(tx, projectId, userId, WORKERS);
  if (!m) throw new ApiError(400, `${what} must be an active Leader or Editor of this project.`);
  return m;
}
async function requireMember(tx: Tx, projectId: string, userId: string) {
  const m = await activeMember(tx, projectId, userId);
  if (!m) throw new ApiError(400, "Collaborators must be active members of this project.");
  return m;
}

// ---------------------------------------------------------------- create (4.1)
export async function createTask(
  user: Actor,
  projectId: string,
  input: {
    title: string; description?: string | null; dueDate?: string | null; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    sectionId?: string; parentId?: string; assigneeId?: string; approverId?: string; collaboratorIds?: string[];
  },
) {
  const a = await projectAccess(user, projectId, { write: true });
  requireWrite(a);
  return db.$transaction(async (tx) => {
    let sectionId: string;
    if (input.parentId) {
      const parent = await tx.task.findFirst({ where: { id: input.parentId, projectId, deletedAt: null } });
      if (!parent) throw notFound("Parent task");
      if (parent.parentId) throw new ApiError(400, "A subtask cannot have subtasks.");
      if (input.approverId) throw new ApiError(400, "Subtasks do not have an approver.");
      sectionId = parent.sectionId;
    } else if (input.sectionId) {
      const s = await tx.section.findFirst({ where: { id: input.sectionId, projectId } });
      if (!s) throw notFound("Section");
      if (s.isDone) throw new ApiError(400, "Add tasks to a section that is not the done section.");
      sectionId = s.id;
    } else {
      const first = await tx.section.findFirst({ where: { projectId, isDone: false }, orderBy: { position: "asc" } })
        ?? (await tx.section.findFirstOrThrow({ where: { projectId }, orderBy: { position: "asc" } }));
      sectionId = first.id;
    }
    const mine = await activeMember(tx, projectId, user.id, WORKERS);
    const assigneeId = input.assigneeId ?? (mine ? user.id : await leaderId(tx, projectId));
    await requireWorker(tx, projectId, assigneeId, "The assignee");
    if (input.approverId) {
      if (input.approverId === assigneeId) throw new ApiError(400, "The approver cannot be the assignee.");
      await requireWorker(tx, projectId, input.approverId, "The approver");
    }
    const collaboratorIds = [...new Set(input.collaboratorIds ?? [])];
    for (const c of collaboratorIds) await requireMember(tx, projectId, c);

    const created = await tx.task.create({
      data: {
        workspaceId: a.project.workspaceId,
        projectId,
        sectionId,
        parentId: input.parentId ?? null,
        title: input.title,
        description: input.description ?? null,
        dueDate: input.dueDate ? parseDueDate(input.dueDate) : null,
        priority: input.priority ?? "MEDIUM",
        assigneeId,
        approverId: input.approverId ?? null,
        createdById: user.id,
        collaborators: { create: collaboratorIds.map((userId) => ({ userId })) },
      },
    });
    await notify(tx, [assigneeId], "TASK_ASSIGNED", { actorId: user.id, taskId: created.id, projectId, data: { title: created.title } });
    await notify(tx, collaboratorIds, "COLLABORATOR_ADDED", { actorId: user.id, taskId: created.id, projectId, data: { title: created.title } });
    await notify(tx, [input.approverId], "APPROVER_NAMED", { actorId: user.id, taskId: created.id, projectId, data: { title: created.title } });
    if (input.approverId) await auditTx(tx, "APPROVER_CHANGED", { actorId: user.id, targetType: "task", targetId: created.id, data: { projectId, approverId: input.approverId, when: "created" } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "task", targetId: created.id, action: "task.created", after: { title: created.title, assigneeId, sectionId, parentId: input.parentId ?? null } });
    return created.id;
  });
}

// ---------------------------------------------------------------- read
export async function getTask(user: Actor, id: string) {
  const { t, a } = await loadTask(user, id);
  const [section, subtasks] = await Promise.all([
    db.section.findUniqueOrThrow({ where: { id: t.sectionId } }),
    db.task.findMany({ where: { parentId: id, deletedAt: null }, include: taskInclude, orderBy: [...ORDER] }),
  ]);
  const viewer = { id: user.id, role: a.role };
  return {
    ...present(t, viewer),
    section: { id: section.id, name: section.name, isDone: section.isDone },
    project: { id: a.project.id, name: a.project.name, archived: !!a.project.archivedAt },
    subtaskList: subtasks.map((s) => present(s, viewer)),
    links: await linksOfTask(id),
  };
}

/** Project list and board (SHO-US-5.2, 5.3). One page of each Section, or one Section paged on its own. */
export async function listTasks(
  user: Actor,
  projectId: string,
  o: { sectionId?: string; cursor?: string; limit?: number; all?: boolean },
) {
  const a = await projectAccess(user, projectId);
  const sections = await db.section.findMany({ where: { projectId, ...(o.sectionId ? { id: o.sectionId } : {}) }, orderBy: { position: "asc" } });
  if (o.sectionId && !sections.length) throw notFound("Section");
  const viewer = { id: user.id, role: a.role };
  const offset = o.cursor ? Math.max(0, Number.parseInt(Buffer.from(o.cursor, "base64url").toString(), 10) || 0) : 0;
  const out = [];
  for (const s of sections) {
    const where = { projectId, sectionId: s.id, parentId: null, deletedAt: null };
    const page = s.isDone && !o.all ? Math.min(o.limit ?? 10, 10) : Math.min(o.limit ?? 50, 100);
    const [total, rows] = await Promise.all([
      db.task.count({ where }),
      db.task.findMany({
        where,
        include: taskInclude,
        orderBy: s.isDone ? [{ completedAt: "desc" }, { id: "asc" }] : [...ORDER],
        skip: offset,
        take: page,
      }),
    ]);
    const end = offset + rows.length;
    out.push({
      id: s.id, name: s.name, isDone: s.isDone, total,
      tasks: rows.map((t) => present(t, viewer)),
      nextCursor: end < total && !(s.isDone && !o.all) ? Buffer.from(String(end)).toString("base64url") : null,
    });
  }
  return { sections: out };
}

/** SHO-BUG-13, APL-2668: every task change says which version it was made on; refused before any read or write without one. */
function requireVersion(expected: string | undefined): asserts expected is string {
  if (!expected) throw new ApiError(400, "expectedUpdatedAt is required");
}

/** SHO-US-14.8 AC4: the same stale-edit answer for every inline edit. */
async function staleCheck(user: Actor, id: string, t: TaskRow, role: Role, expected?: string) {
  if (expected && new Date(expected).getTime() !== t.updatedAt.getTime()) {
    const last = await db.actionLog.findFirst({ where: { targetType: "task", targetId: id }, orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } } } });
    throw new ApiError(409, "This task changed while you were editing it.", { stale: true, changedBy: last?.actor.name ?? null, current: present(t, { id: user.id, role }) });
  }
}

// ---------------------------------------------------------------- edit (4.2, 4.4)
export async function updateTask(
  user: Actor,
  id: string,
  input: {
    title?: string; description?: string | null; dueDate?: string | null; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    blocked?: boolean; blockedReason?: string | null; expectedUpdatedAt: string;
  },
) {
  // SHO-BUG-13: every edit says which version it was made on, so a concurrent save is never silently overwritten.
  if (!input.expectedUpdatedAt) throw new ApiError(400, "expectedUpdatedAt is required");
  const { t, a } = await loadTask(user, id, { write: true });
  await staleCheck(user, id, t, a.role, input.expectedUpdatedAt);
  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const set = (k: string, v: unknown, old: unknown) => {
    if (JSON.stringify(v) !== JSON.stringify(old)) { data[k] = v; before[k] = old; }
  };
  if (input.title !== undefined) set("title", input.title, t.title);
  if (input.description !== undefined) set("description", input.description ?? null, t.description);
  if (input.dueDate !== undefined) set("dueDate", input.dueDate ? parseDueDate(input.dueDate) : null, t.dueDate);
  if (input.priority !== undefined) set("priority", input.priority, t.priority);
  let newlyBlocked = false;
  if (input.blocked === false) {
    set("blocked", false, t.blocked);
    if (t.blockedReason !== null) set("blockedReason", null, t.blockedReason);
  } else if (input.blocked === true || (t.blocked && input.blockedReason !== undefined)) {
    set("blocked", true, t.blocked);
    if (input.blockedReason !== undefined) set("blockedReason", input.blockedReason ?? null, t.blockedReason);
    newlyBlocked = !t.blocked;
  }
  if (!Object.keys(data).length) return;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data });
    if (newlyBlocked) {
      await notify(tx, [await leaderId(tx, t.projectId)], "TASK_BLOCKED", {
        actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title, reason: input.blockedReason ?? null },
      });
    }
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.updated", before, after: data });
    if ("dueDate" in data) await ensureNextStep(tx, t.projectId, user.id);
  });
}

// ---------------------------------------------------------------- assign, collaborators, approver (4.3, 4.6)
export async function assignTask(user: Actor, id: string, assigneeId: string, expectedUpdatedAt: string) {
  requireVersion(expectedUpdatedAt);
  const { t, a } = await loadTask(user, id, { write: true });
  await staleCheck(user, id, t, a.role, expectedUpdatedAt);
  // The assignee may only hand a task with an approver on to that approver; the Leader and Admins keep full authority (SHO-BUG-6).
  if (t.approverId && user.id === t.assigneeId && assigneeId !== t.approverId && a.role !== "LEADER") {
    throw new ApiError(403, "With an approver, this task can only be handed to the approver.");
  }
  await db.$transaction(async (tx) => {
    await requireWorker(tx, t.projectId, assigneeId, "The assignee");
    const toApprover = t.approverId === assigneeId && t.assigneeId !== assigneeId;
    await tx.task.update({ where: { id }, data: { assigneeId, ...(toApprover ? { previousAssigneeId: t.assigneeId } : {}) } });
    await notify(tx, [assigneeId], toApprover ? "SENT_FOR_APPROVAL" : "TASK_ASSIGNED", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    // SHO-US-7.2 AC3: the person who held it is told it moved on.
    if (t.assigneeId !== assigneeId) await notify(tx, [t.assigneeId], "REMOVED_AS_ASSIGNEE", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.assigned", before: { assigneeId: t.assigneeId, previousAssigneeId: t.previousAssigneeId }, after: { assigneeId, previousAssigneeId: toApprover ? t.assigneeId : t.previousAssigneeId } });
  });
}

export async function addCollaborator(user: Actor, id: string, userId: string) {
  const { t } = await loadTask(user, id, { write: true });
  await db.$transaction(async (tx) => {
    await requireMember(tx, t.projectId, userId);
    if (t.collaborators.some((c) => c.user.id === userId)) throw new ApiError(409, "Already a collaborator.");
    await tx.taskCollaborator.create({ data: { taskId: id, userId } });
    await notify(tx, [userId], "COLLABORATOR_ADDED", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.collaborator_added", after: { userId } });
  });
}

export async function removeCollaborator(user: Actor, id: string, userId: string) {
  const { t } = await loadTask(user, id, { write: true });
  if (!t.collaborators.some((c) => c.user.id === userId)) throw notFound("Collaborator");
  await db.$transaction(async (tx) => {
    await tx.taskCollaborator.delete({ where: { taskId_userId: { taskId: id, userId } } });
    await notify(tx, [userId], "COLLABORATOR_REMOVED", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.collaborator_removed", before: { userId } });
  });
}

export async function setApprover(user: Actor, id: string, approverId: string | null, expectedUpdatedAt: string) {
  requireVersion(expectedUpdatedAt);
  const { t, a } = await loadTask(user, id, { write: true });
  await staleCheck(user, id, t, a.role, expectedUpdatedAt);
  if (t.parentId) throw new ApiError(400, "Subtasks do not have an approver.");
  if (user.id === t.assigneeId) throw new ApiError(403, "The assignee cannot change their own task's approver.");
  const isAwaiting = awaiting(t);
  if (isAwaiting && a.role !== "LEADER") throw new ApiError(403, "Only the Leader or an Admin can change the approver while a task awaits approval.");
  if (!isAwaiting && a.role !== "LEADER" && t.createdById !== user.id) {
    throw new ApiError(403, "Only the Leader, an Admin or the task's creator can set the approver.");
  }
  await db.$transaction(async (tx) => {
    if (approverId) {
      if (approverId === t.assigneeId && !isAwaiting) throw new ApiError(400, "The approver cannot be the assignee.");
      if (approverId === t.approverId) throw new ApiError(409, "That person is already the approver.");
      await requireWorker(tx, t.projectId, approverId, "The approver");
    }
    const data = isAwaiting && approverId ? { approverId, assigneeId: approverId } : { approverId };
    await tx.task.update({ where: { id }, data });
    await notify(tx, [approverId], isAwaiting ? "SENT_FOR_APPROVAL" : "APPROVER_NAMED", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    if (isAwaiting && approverId) await notify(tx, [t.assigneeId], "REMOVED_AS_ASSIGNEE", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.approver_changed", before: { approverId: t.approverId, assigneeId: t.assigneeId }, after: data });
  });
}

export async function sendForApproval(user: Actor, id: string) {
  const { t } = await loadTask(user, id, { write: true });
  if (!t.approverId) throw new ApiError(409, "This task has no approver.");
  if (awaiting(t)) throw new ApiError(409, "This task is already awaiting approval.");
  if (user.id !== t.assigneeId) throw new ApiError(403, "Only the assignee can send a task for approval.");
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { assigneeId: t.approverId!, previousAssigneeId: t.assigneeId } });
    await notify(tx, [t.approverId], "SENT_FOR_APPROVAL", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.sent_for_approval", before: { assigneeId: t.assigneeId, previousAssigneeId: t.previousAssigneeId }, after: { assigneeId: t.approverId, previousAssigneeId: t.assigneeId } });
  });
}

export async function sendBack(user: Actor, id: string) {
  const { t, a } = await loadTask(user, id, { write: true, holderCanDo: true });
  if (!awaiting(t)) throw new ApiError(409, "This task is not awaiting approval.");
  if (user.id !== t.approverId && a.role !== "LEADER") throw new ApiError(403, "Only the approver, the Leader or an Admin can send this back.");
  await db.$transaction(async (tx) => {
    const prev = t.previousAssigneeId ? await activeMember(tx, t.projectId, t.previousAssigneeId, WORKERS) : null;
    const target = prev ? prev.userId : await leaderId(tx, t.projectId);
    // With nobody to send back to, the task goes to the Leader. When the Leader is the approver it would still be
    // "awaiting approval" in their own hands, and neither Reassign nor Change approver is open to them from there, so the
    // approver is cleared in the same write; Undo puts it back (SHO-BUG-6).
    const clearApprover = target === t.approverId;
    const approver = clearApprover ? { approverId: null } : {};
    await tx.task.update({ where: { id }, data: { assigneeId: target, previousAssigneeId: null, ...approver } });
    await notify(tx, [target], "SENT_BACK", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title, toLeader: !prev, ...(clearApprover ? { approverCleared: true } : {}) } });
    await notify(tx, [t.assigneeId], "REMOVED_AS_ASSIGNEE", { actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title } });
    await logAction(tx, {
      actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.sent_back",
      before: { assigneeId: t.assigneeId, previousAssigneeId: t.previousAssigneeId, ...(clearApprover ? { approverId: t.approverId } : {}) },
      after: { assigneeId: target, previousAssigneeId: null, ...approver },
    });
  });
}

// ---------------------------------------------------------------- complete, reopen, move (4.5)
export async function completeTask(user: Actor, id: string, expectedUpdatedAt: string, completeAll = false) {
  requireVersion(expectedUpdatedAt);
  const { t, a } = await loadTask(user, id, { write: true, holderCanDo: true });
  await staleCheck(user, id, t, a.role, expectedUpdatedAt);
  if (!canClose(user.id, a.role, t)) {
    throw new ApiError(403, t.approverId ? "Only the approver, the Leader or an Admin can close this task." : "You cannot complete this task.");
  }
  if (t.completedAt) throw new ApiError(409, "This task is already complete.");
  const openSubs = await db.task.findMany({ where: { parentId: id, deletedAt: null, completedAt: null }, select: { id: true } });
  if (openSubs.length && !completeAll) {
    throw new ApiError(409, `This task has ${openSubs.length} open subtask${openSubs.length === 1 ? "" : "s"}.`, { needsConfirm: "open_subtasks", openSubtasks: openSubs.length });
  }
  await db.$transaction(async (tx) => {
    const now = new Date();
    if (t.parentId) {
      await tx.task.update({ where: { id }, data: { completedAt: now } });
    } else {
      const done = await tx.section.findFirstOrThrow({ where: { projectId: t.projectId, isDone: true } });
      await tx.task.update({ where: { id }, data: { completedAt: now, sectionId: done.id, previousSectionId: t.sectionId === done.id ? t.previousSectionId : t.sectionId } });
      if (openSubs.length) {
        await tx.task.updateMany({ where: { id: { in: openSubs.map((s) => s.id) } }, data: { completedAt: now } });
        for (const sub of openSubs) {
          await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: sub.id, action: "task.completed", before: { completedAt: null }, after: { completedAt: now.toISOString(), withParent: id }, primary: false });
        }
      }
    }
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.completed", before: { sectionId: t.sectionId, completedAt: null, previousSectionId: t.previousSectionId }, after: { completedAt: now.toISOString(), subtasksCompleted: openSubs.length, subtaskIds: openSubs.map((s) => s.id) } });
    if (!t.parentId) await ensureNextStep(tx, t.projectId, user.id);
  });
}

export async function reopenTask(user: Actor, id: string, sectionId?: string) {
  const { t } = await loadTask(user, id, { write: true });
  if (!t.completedAt) throw new ApiError(409, "This task is not complete.");
  await db.$transaction(async (tx) => {
    if (t.parentId) {
      const parent = await tx.task.findUniqueOrThrow({ where: { id: t.parentId } });
      if (parent.completedAt) throw new ApiError(409, "Reopen the parent task first.");
      await tx.task.update({ where: { id }, data: { completedAt: null } });
    } else {
      let dest: string | null = null;
      if (sectionId) {
        const s = await tx.section.findFirst({ where: { id: sectionId, projectId: t.projectId } });
        if (!s) throw notFound("Section");
        if (s.isDone) throw new ApiError(400, "Choose a section that is not the done section.");
        dest = s.id;
      } else {
        const prev = t.previousSectionId ? await tx.section.findFirst({ where: { id: t.previousSectionId, projectId: t.projectId, isDone: false } }) : null;
        dest = (prev ?? (await tx.section.findFirst({ where: { projectId: t.projectId, isDone: false }, orderBy: { position: "asc" } })) ?? (await tx.section.findFirstOrThrow({ where: { projectId: t.projectId }, orderBy: { position: "asc" } }))).id;
      }
      await tx.task.update({ where: { id }, data: { completedAt: null, sectionId: dest, previousSectionId: null } });
    }
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.reopened", before: { completedAt: t.completedAt, sectionId: t.sectionId }, after: { completedAt: null } });
  });
}

/** Dragging a card. Into the done Section completes, out of it reopens, otherwise only the Section changes. */
export async function moveTask(user: Actor, id: string, sectionId: string, expectedUpdatedAt: string, completeAll = false) {
  requireVersion(expectedUpdatedAt);
  const { t, a } = await loadTask(user, id, { write: true, holderCanDo: true });
  await staleCheck(user, id, t, a.role, expectedUpdatedAt);
  if (t.parentId) throw new ApiError(409, "Subtasks move with their parent task.");
  const dest = await db.section.findFirst({ where: { id: sectionId, projectId: t.projectId } });
  if (!dest) throw notFound("Section");
  if (dest.id === t.sectionId) return;
  if (dest.isDone) return completeTask(user, id, expectedUpdatedAt, completeAll);
  if (t.completedAt) return reopenTask(user, id, dest.id);
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { sectionId: dest.id } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.moved", before: { sectionId: t.sectionId }, after: { sectionId: dest.id } });
  });
}

// ---------------------------------------------------------------- delete, restore, trash (6.1, 6.2)
export async function deleteTask(user: Actor, id: string, o: { byUndo?: boolean } = {}) {
  const { t, a } = await loadTask(user, id, { write: true });
  await db.$transaction(async (tx) => {
    const now = new Date();
    await tx.task.updateMany({ where: { OR: [{ id }, { parentId: id }], deletedAt: null }, data: { deletedAt: now, deletedById: user.id } });
    const leader = await leaderId(tx, t.projectId);
    if (o.byUndo) return; // Undo logs its own row and sends no notice
    await notify(tx, [leader, t.assigneeId, t.approverId, ...t.collaborators.map((c) => c.user.id)], "TASK_DELETED", {
      actorId: user.id, taskId: id, projectId: t.projectId, data: { title: t.title },
    });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.deleted", before: { title: t.title, sectionId: t.sectionId, deletedAt: null }, after: { deletedAt: now.toISOString() } });
    // Undoing a delete is a restore from Trash, so only those who may restore get the Undo toast (APL-2649).
    const ctx = reqCtx.getStore();
    if (ctx && !canManage(a)) { ctx.undoId = undefined; ctx.undoLabel = undefined; }
    await ensureNextStep(tx, t.projectId, user.id);
  });
}

export async function restoreTask(user: Actor, id: string, confirmParent = false, o: { skipLog?: boolean } = {}) {
  const { t, a } = await loadTask(user, id, { write: true, deleted: true });
  requireManage(a); // SHO-US-3.3 AC1: only the Leader or an Admin restores from Trash
  if (!t.deletedAt) throw new ApiError(409, "This task is not in Trash.");
  const parent = t.parentId ? await db.task.findUnique({ where: { id: t.parentId } }) : null;
  const parentDeleted = !!parent?.deletedAt;
  if (parentDeleted && !confirmParent) {
    throw new ApiError(409, `This will also restore its parent task, "${parent!.title}".`, { needsConfirm: "parent", parentTitle: parent!.title });
  }
  await db.$transaction(async (tx) => {
    const leader = await leaderId(tx, t.projectId);
    const targets = parentDeleted ? [parent!, t] : [t];
    for (const x of targets) {
      const assigneeOk = await activeMember(tx, t.projectId, x.assigneeId, WORKERS);
      const approverOk = x.approverId ? await activeMember(tx, t.projectId, x.approverId, WORKERS) : null;
      const subs = await tx.task.findMany({ where: { parentId: x.id, deletedAt: x.deletedAt }, select: { id: true, assigneeId: true } });
      await tx.task.updateMany({
        where: { OR: [{ id: x.id }, { parentId: x.id, deletedAt: x.deletedAt }] },
        data: { deletedAt: null, deletedById: null },
      });
      // A subtask whose assignee left while it sat in Trash also goes to the Leader (SHO-US-6.2 AC3).
      for (const s of subs) {
        if (!(await activeMember(tx, t.projectId, s.assigneeId, WORKERS))) {
          await tx.task.update({ where: { id: s.id }, data: { assigneeId: leader } });
        }
      }
      if (!assigneeOk) {
        await tx.task.update({ where: { id: x.id }, data: { assigneeId: leader } });
        await notify(tx, [leader], "RESTORED_TO_LEADER", { actorId: user.id, taskId: x.id, projectId: t.projectId, data: { title: x.title } });
      }
      if (x.approverId && !approverOk) {
        await tx.task.update({ where: { id: x.id }, data: { approverId: null } });
        await notify(tx, [leader, assigneeOk ? x.assigneeId : null], "APPROVER_CLEARED", { actorId: user.id, taskId: x.id, projectId: t.projectId, data: { title: x.title } });
      }
    }
    if (!o.skipLog) await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.restored", before: { deletedAt: t.deletedAt!.toISOString(), title: t.title }, after: { deletedAt: null, restoredParent: parentDeleted } });
  });
}

export async function listTrash(user: Actor, projectId: string) {
  await projectAccess(user, projectId);
  const all = await db.task.findMany({
    where: { projectId, deletedAt: { not: null } },
    include: { deletedBy: { select: { id: true, name: true } }, parent: { select: { title: true, deletedAt: true } } },
    orderBy: { deletedAt: "desc" },
  });
  // A subtask deleted together with its parent comes back with it, so only the parent is listed. A subtask deleted on its own
  // earlier is listed even when its parent is in Trash too, so the "restore both" confirmation can be reached (SHO-US-6.2 AC2).
  const rows = all.filter((t) => !t.parent?.deletedAt || t.parent.deletedAt.getTime() !== t.deletedAt!.getTime());
  const now = Date.now();
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    isSubtask: !!t.parentId,
    parentTitle: t.parent?.title ?? null,
    deletedAt: t.deletedAt,
    deletedBy: t.deletedBy,
    daysLeft: Math.max(0, 30 - Math.floor((now - t.deletedAt!.getTime()) / 86400_000)),
  }));
}

/** Scheduled job: removes tasks that have been in Trash for 30 days. Nothing is removed earlier. */
export async function purgeTrash(now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 86400_000);
  const r = await db.task.deleteMany({ where: { deletedAt: { lte: cutoff } } });
  if (r.count) await db.auditLog.create({ data: { event: "TASK_PURGED", channel: "SCREEN", data: { count: r.count } } });
  return r.count;
}

// ---------------------------------------------------------------- My tasks (5.1)
/** Open tasks where I am assignee or collaborator, in my active projects, grouped by due date in IST. */
export async function myTasks(user: Actor) {
  const rows = await db.task.findMany({
    where: {
      completedAt: null,
      deletedAt: null,
      // Deal tasks are left out while the CRM is hidden from this person (SHO-BUG-2).
      project: { archivedAt: null, members: { some: { userId: user.id } }, ...crmProjectWhere(user) },
      OR: [{ assigneeId: user.id }, { collaborators: { some: { userId: user.id } } }],
    },
    include: {
      ...taskInclude,
      project: { select: { id: true, name: true, typeId: true, stage: { select: { name: true } }, members: { where: { userId: user.id }, select: { role: true } } } },
      parent: { select: { id: true, title: true } },
    },
    orderBy: [...ORDER],
  });
  const today = startOfTodayIST();
  const weekEnd = addDays(today, 8); // today plus the next seven days
  // SHO-US-14.16: what waits on me, and what I handed to an approver, since when.
  const sent = await db.task.findMany({
    where: {
      completedAt: null, deletedAt: null, previousAssigneeId: user.id, approverId: { not: null }, assigneeId: { not: user.id },
      project: { archivedAt: null, members: { some: { userId: user.id } } },
    },
    include: { ...taskInclude, project: { select: { id: true, name: true, typeId: true, stage: { select: { name: true } }, members: { where: { userId: user.id }, select: { role: true } } } }, parent: { select: { id: true, title: true } } },
    orderBy: [...ORDER],
  });
  const since = await waitingSince([...rows.filter(awaiting), ...sent.filter(awaiting)].map((t) => t.id));
  const days = (id: string, fallback: Date) => Math.max(0, Math.floor((Date.now() - (since.get(id) ?? fallback).getTime()) / 86400_000));
  const groups = { waitingOnMe: [] as unknown[], overdue: [] as unknown[], next7: [] as unknown[], later: [] as unknown[], waitingOnOthers: [] as unknown[] };
  const shape = (t: (typeof rows)[number]) => ({
    ...present(t, { id: user.id, role: (t.project.members[0]?.role ?? "VIEWER") as Role }),
    project: { id: t.project.id, name: t.project.name, type: t.project.typeId === "wst_deal" ? "DEAL" : "PROJECT", stage: t.project.stage?.name ?? null },
    parent: t.parent,
    relation: t.assigneeId === user.id ? "ASSIGNEE" : "COLLABORATOR",
  });
  for (const t of rows) {
    const item = shape(t);
    // A task held for my approval is not "later"; it sits in its own group at the top.
    if (awaiting(t) && t.assigneeId === user.id) groups.waitingOnMe.push({ ...item, waitingDays: days(t.id, t.updatedAt) });
    else if (t.dueDate && t.dueDate < today) groups.overdue.push(item);
    else if (t.dueDate && t.dueDate < weekEnd) groups.next7.push(item);
    else groups.later.push(item);
  }
  for (const t of sent) if (awaiting(t)) groups.waitingOnOthers.push({ ...shape(t), waitingDays: days(t.id, t.updatedAt) });
  return groups;
}

/** When each task last went to its approver: the newest action that put it in the approver's hands. */
async function waitingSince(ids: string[]) {
  const out = new Map<string, Date>();
  if (!ids.length) return out;
  const rows = await db.actionLog.findMany({
    where: { targetType: "task", targetId: { in: ids }, action: { in: ["task.sent_for_approval", "task.assigned", "task.approver_changed"] }, undoneAt: null },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, createdAt: true, afterState: true },
  });
  for (const r of rows) {
    const after = (r.afterState ?? {}) as { assigneeId?: string; approverId?: string };
    if (!out.has(r.targetId) && after.assigneeId) out.set(r.targetId, r.createdAt);
  }
  return out;
}


/** SHO-US-13.2: Editors flag or unflag an idea; logged with before and after, undoable. */
export async function setIdea(user: Actor, id: string, isIdea: boolean) {
  const { t } = await loadTask(user, id, { write: true });
  if (t.parentId) throw new ApiError(400, "Only a top-level task can be an idea.");
  if (t.isIdea === isIdea) return;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { isIdea } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: id, action: "task.idea_changed", before: { isIdea: t.isIdea }, after: { isIdea } });
  });
}
