/* eslint-disable @typescript-eslint/no-explicit-any */
// SHO-US-6.4: Undo from the stored before-state, with a conflict warning and "Undo anyway".
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { WORKERS, activeMember, projectAccess, requireWrite, type Actor, type Tx } from "@/lib/access";
import { formatDueDate } from "@/lib/dates";
import { auditTx, logAction, notify } from "@/lib/notify";
import { deleteTask, restoreTask } from "@/lib/tasks";
import { UNDO_DAYS, UNDO_LABELS, isUndoable } from "@/lib/undoable";

type Conflict = { field: string; before: unknown; after: unknown; now: unknown };
type Plan = { conflicts: Conflict[]; apply: (tx: Tx) => Promise<void>; subject?: string; fields?: string };

const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const bad = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, msg, extra);

/** Actions that sent a bell notice, so Undo can say the notice was already delivered (AC4). */
const NOTIFYING = new Set([
  "task.created", "task.assigned", "task.sent_for_approval", "task.sent_back", "task.approver_changed", "task.collaborator_added",
  "task.collaborator_removed", "task.deleted", "project.archived", "member.added", "member.removed", "member.role_changed", "project.leader_changed",
]);

const FIELD_LABEL: Record<string, string> = {
  title: "Title", description: "Description", dueDate: "Due date", priority: "Priority", blocked: "Blocked", blockedReason: "Blocked reason",
  assigneeId: "Assignee", approverId: "Approver", sectionId: "Section", name: "Name", role: "Role", leaderId: "Leader", position: "Position",
};

async function taskOf(id: string, projectId: string) {
  const t = await db.task.findFirst({ where: { id, projectId } });
  if (!t) throw bad("This task no longer exists.");
  return t;
}
const liveTask = async (id: string, projectId: string) => {
  const t = await taskOf(id, projectId);
  if (t.deletedAt) throw bad("This task is in Trash. Restore it first.");
  return t;
};

function fieldConflicts(keys: string[], before: any, after: any, now: Record<string, unknown>): Conflict[] {
  return keys.filter((k) => !same(now[k], after[k])).map((k) => ({ field: k, before: before[k], after: after[k], now: now[k] }));
}

async function plan(row: any, user: Actor, projectId: string): Promise<Plan> {
  const b = (row.beforeState ?? {}) as any;
  const f = (row.afterState ?? {}) as any;
  const id = row.targetId as string;
  switch (row.action as string) {
    case "task.updated": {
      const t = await liveTask(id, projectId);
      const now: Record<string, unknown> = { title: t.title, description: t.description, dueDate: t.dueDate, priority: t.priority, blocked: t.blocked, blockedReason: t.blockedReason };
      const keys = Object.keys(b);
      const data: Record<string, unknown> = {};
      for (const k of keys) data[k] = k === "dueDate" ? (b[k] ? new Date(b[k]) : null) : b[k];
      return { conflicts: fieldConflicts(keys, b, f, now), subject: t.title, fields: keys.map((k) => FIELD_LABEL[k] ?? k).join(", "), apply: async (tx) => { await tx.task.update({ where: { id }, data }); } };
    }
    case "task.assigned": case "task.sent_for_approval": case "task.sent_back": {
      const t = await liveTask(id, projectId);
      return {
        conflicts: fieldConflicts(["assigneeId"], b, f, { assigneeId: t.assigneeId }), subject: t.title, fields: "Assignee",
        apply: async (tx) => {
          if (!(await activeMember(tx, projectId, b.assigneeId, WORKERS))) throw bad("The previous assignee can no longer take this task.");
          await tx.task.update({ where: { id }, data: { assigneeId: b.assigneeId, previousAssigneeId: b.previousAssigneeId ?? null } });
        },
      };
    }
    case "task.approver_changed": {
      const t = await liveTask(id, projectId);
      const keys = Object.keys(f).filter((k) => k === "approverId" || k === "assigneeId");
      return {
        conflicts: fieldConflicts(keys, b, f, { approverId: t.approverId, assigneeId: t.assigneeId }), subject: t.title, fields: "Approver",
        apply: async (tx) => {
          for (const k of keys) if (b[k] && !(await activeMember(tx, projectId, b[k], WORKERS))) throw bad("The previous person can no longer take that role.");
          await tx.task.update({ where: { id }, data: Object.fromEntries(keys.map((k) => [k, b[k] ?? null])) });
        },
      };
    }
    case "task.collaborator_added": {
      const t = await liveTask(id, projectId);
      const has = await db.taskCollaborator.findUnique({ where: { taskId_userId: { taskId: id, userId: f.userId } } });
      if (!has) throw bad("That collaborator was already removed.");
      return { conflicts: [], subject: t.title, apply: async (tx) => { await tx.taskCollaborator.delete({ where: { taskId_userId: { taskId: id, userId: f.userId } } }); } };
    }
    case "task.collaborator_removed": {
      const t = await liveTask(id, projectId);
      if (await db.taskCollaborator.findUnique({ where: { taskId_userId: { taskId: id, userId: b.userId } } })) throw bad("That person is a collaborator again already.");
      return {
        conflicts: [], subject: t.title,
        apply: async (tx) => {
          if (!(await activeMember(tx, projectId, b.userId))) throw bad("That person is no longer an active member of the project.");
          await tx.taskCollaborator.create({ data: { taskId: id, userId: b.userId } });
        },
      };
    }
    case "task.completed": {
      const t = await liveTask(id, projectId);
      if (!t.completedAt) throw bad("This task was already reopened.");
      if (t.parentId) {
        const parent = await db.task.findUniqueOrThrow({ where: { id: t.parentId } });
        if (parent.completedAt) throw bad("Reopen the parent task first.");
      }
      return {
        conflicts: [], subject: t.title,
        apply: async (tx) => {
          if (t.parentId) { await tx.task.update({ where: { id }, data: { completedAt: null } }); return; }
          const sec = b.sectionId ? await tx.section.findFirst({ where: { id: b.sectionId, projectId, isDone: false } }) : null;
          const dest = sec ?? (await tx.section.findFirstOrThrow({ where: { projectId, isDone: false }, orderBy: { position: "asc" } }));
          await tx.task.update({ where: { id }, data: { completedAt: null, sectionId: dest.id, previousSectionId: b.previousSectionId ?? null } });
          if (Array.isArray(f.subtaskIds) && f.subtaskIds.length) await tx.task.updateMany({ where: { id: { in: f.subtaskIds } }, data: { completedAt: null } });
        },
      };
    }
    case "task.reopened": {
      const t = await liveTask(id, projectId);
      if (t.completedAt) throw bad("This task was already completed again.");
      return {
        conflicts: [], subject: t.title,
        apply: async (tx) => {
          if (t.parentId) { await tx.task.update({ where: { id }, data: { completedAt: new Date(b.completedAt ?? Date.now()) } }); return; }
          const done = await tx.section.findFirstOrThrow({ where: { projectId, isDone: true } });
          await tx.task.update({ where: { id }, data: { completedAt: new Date(b.completedAt ?? Date.now()), sectionId: done.id, previousSectionId: t.sectionId } });
        },
      };
    }
    case "task.moved": {
      const t = await liveTask(id, projectId);
      return {
        conflicts: fieldConflicts(["sectionId"], b, f, { sectionId: t.sectionId }), subject: t.title, fields: "Section",
        apply: async (tx) => {
          if (!(await tx.section.findFirst({ where: { id: b.sectionId, projectId } }))) throw bad("The section it came from no longer exists.");
          await tx.task.update({ where: { id }, data: { sectionId: b.sectionId } });
        },
      };
    }
    case "task.deleted": {
      const t = await taskOf(id, projectId);
      if (!t.deletedAt) throw bad("This task is already restored.");
      return { conflicts: [], subject: t.title, apply: async () => {} }; // restored by `undoAction` before the log is written
    }
    case "task.restored": case "task.created": {
      const t = await taskOf(id, projectId);
      if (t.deletedAt) throw bad("This task is already in Trash.");
      return { conflicts: [], subject: t.title, apply: async () => {} };
    }
    case "project.updated": {
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      const keys = Object.keys(f);
      return { conflicts: fieldConflicts(keys, b, f, { name: p.name, description: p.description }), subject: p.name, fields: keys.join(", "), apply: async (tx) => { await tx.project.update({ where: { id: projectId }, data: Object.fromEntries(keys.map((k) => [k, b[k]])) }); } };
    }
    case "project.archived": {
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      if (!p.archivedAt) throw bad("This project is not archived any more.");
      return { conflicts: [], subject: p.name, apply: async (tx) => { await tx.project.update({ where: { id: projectId }, data: { archivedAt: null } }); } };
    }
    case "project.unarchived": {
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      if (p.archivedAt) throw bad("This project is archived again already.");
      return { conflicts: [], subject: p.name, apply: async (tx) => { await tx.project.update({ where: { id: projectId }, data: { archivedAt: new Date(b.archivedAt ?? Date.now()) } }); } };
    }
    case "project.leader_changed": {
      if (f.previousRole === "REMOVE") throw bad("The previous Leader was removed from the project, so this cannot be undone here. Use Change Leader.");
      if (f.handedOver > 0) throw bad("Tasks were handed over with this change, so it cannot be undone. Use Change Leader.");
      const cur = await db.projectMember.findFirst({ where: { projectId, role: "LEADER" } });
      return {
        conflicts: cur && cur.userId !== f.leaderId ? [{ field: "leaderId", before: b.leaderId, after: f.leaderId, now: cur.userId }] : [], subject: "the project Leader", fields: "Leader",
        apply: async (tx) => {
          if (!(await activeMember(tx, projectId, b.leaderId))) throw bad("The previous Leader is not an active member any more.");
          await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: cur!.userId } }, data: { role: "EDITOR" } });
          await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: b.leaderId } }, data: { role: "LEADER" } });
        },
      };
    }
    case "member.added": {
      const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: id } } });
      if (!m) throw bad("That person is not a member any more.");
      if (await db.task.count({ where: { projectId, assigneeId: id, completedAt: null, deletedAt: null } })) throw bad("That person now holds open tasks. Remove them from Members and choose who takes the tasks.");
      return {
        conflicts: m.role !== f.role ? [{ field: "role", before: null, after: f.role, now: m.role }] : [], subject: "the member", fields: "Role",
        apply: async (tx) => {
          await tx.taskCollaborator.deleteMany({ where: { userId: id, task: { projectId } } });
          await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId: id } } });
        },
      };
    }
    case "member.removed": {
      if (f.handedOver > 0) throw bad("Their tasks were handed over when they were removed, so this cannot be undone. Add them again from Members.");
      if (await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: id } } })) throw bad("That person is a member again already.");
      return {
        conflicts: [], subject: "the member",
        apply: async (tx) => {
          if (!(await activeMember(tx, projectId, id) ?? (await tx.user.findFirst({ where: { id, deactivatedAt: null, emailVerifiedAt: { not: null } } })))) throw bad("That person is not active any more.");
          await tx.projectMember.create({ data: { projectId, userId: id, role: b.role } });
        },
      };
    }
    case "member.role_changed": {
      if (f.handedOver > 0) throw bad("Their tasks were handed over with this change, so it cannot be undone. Change the role from Members.");
      const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: id } } });
      if (!m) throw bad("That person is not a member any more.");
      return {
        conflicts: m.role !== f.role ? [{ field: "role", before: b.role, after: f.role, now: m.role }] : [], subject: "the member", fields: "Role",
        apply: async (tx) => { await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: id } }, data: { role: b.role } }); },
      };
    }
    case "section.added": {
      const s = await db.section.findFirst({ where: { id, projectId } });
      if (!s) throw bad("That section no longer exists.");
      if (s.isDone) throw bad("That section is now the done section.");
      if ((await db.task.count({ where: { sectionId: id } })) > 0) throw bad("That section now holds tasks, so it cannot be undone. Delete it and choose where its tasks go.");
      return { conflicts: [], subject: s.name, apply: async (tx) => { await tx.section.delete({ where: { id } }); await renumber(tx, projectId); } };
    }
    case "section.renamed": {
      const s = await db.section.findFirst({ where: { id, projectId } });
      if (!s) throw bad("That section no longer exists.");
      return { conflicts: fieldConflicts(["name"], b, f, { name: s.name }), subject: s.name, fields: "Name", apply: async (tx) => { await tx.section.update({ where: { id }, data: { name: b.name } }); } };
    }
    case "section.moved": {
      const all = await db.section.findMany({ where: { projectId }, orderBy: { position: "asc" } });
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) throw bad("That section no longer exists.");
      return {
        conflicts: i !== f.position ? [{ field: "position", before: b.position, after: f.position, now: i }] : [], subject: all[i].name, fields: "Position",
        apply: async (tx) => {
          const arr = [...all];
          const [x] = arr.splice(i, 1);
          arr.splice(Math.min(b.position, arr.length), 0, x);
          for (const [pos, sec] of arr.entries()) await tx.section.update({ where: { id: sec.id }, data: { position: pos } });
        },
      };
    }
    case "section.done_changed": {
      const cur = await db.section.findFirst({ where: { projectId, isDone: true } });
      if (!b.doneSectionId || !(await db.section.findFirst({ where: { id: b.doneSectionId, projectId } }))) throw bad("The earlier done section no longer exists.");
      return {
        conflicts: cur && cur.id !== f.doneSectionId ? [{ field: "sectionId", before: b.doneSectionId, after: f.doneSectionId, now: cur.id }] : [], subject: "the done section", fields: "Done section",
        apply: async (tx) => {
          if (cur) await tx.section.update({ where: { id: cur.id }, data: { isDone: false } });
          await tx.section.update({ where: { id: b.doneSectionId }, data: { isDone: true } });
          if (Array.isArray(f.completedTaskIds) && f.completedTaskIds.length) await tx.task.updateMany({ where: { id: { in: f.completedTaskIds } }, data: { completedAt: null } });
          if (Array.isArray(b.reopenedTaskIds) && b.reopenedTaskIds.length) await tx.task.updateMany({ where: { id: { in: b.reopenedTaskIds }, completedAt: null }, data: { completedAt: new Date() } });
        },
      };
    }
  }
  throw bad("This kind of action cannot be undone.");
}

async function renumber(tx: Tx, projectId: string) {
  const rest = await tx.section.findMany({ where: { projectId }, orderBy: { position: "asc" } });
  for (const [pos, sec] of rest.entries()) await tx.section.update({ where: { id: sec.id }, data: { position: pos } });
}

/** Names for ids shown in the conflict dialog. */
async function present(conflicts: Conflict[]) {
  const ids = new Set<string>();
  for (const c of conflicts) for (const v of [c.before, c.after, c.now]) if (typeof v === "string" && v.length > 20) ids.add(v);
  const [us, ss] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
    db.section.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
  ]);
  const names = new Map<string, string>([...us, ...ss].map((x) => [x.id, x.name] as [string, string]));
  const show = (field: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return "none";
    if (field === "dueDate") return formatDueDate(new Date(v as string)) ?? "none";
    if (typeof v === "string") return names.get(v) ?? v;
    return String(v);
  };
  return conflicts.map((c) => ({ field: FIELD_LABEL[c.field] ?? c.field, before: show(c.field, c.before), after: show(c.field, c.after), now: show(c.field, c.now) }));
}

async function prepare(user: Actor, logId: string) {
  const row = await db.actionLog.findUnique({ where: { id: logId } });
  if (!row || !row.projectId) throw notFound("Action");
  const projectId = row.projectId;
  const a = await projectAccess(user, projectId);
  requireWrite(a);
  const archiveKind = row.action === "project.archived" || row.action === "project.unarchived";
  if (a.project.archivedAt && !archiveKind) throw new ApiError(409, "This project is archived and read-only.");
  if (row.actorId !== user.id && a.role !== "LEADER") throw new ApiError(403, "You can only undo your own actions.");
  if (row.undoneAt) throw bad("This action was already undone.");
  if (!isUndoable(row.action)) throw bad("This kind of action cannot be undone.");
  if (Date.now() - row.createdAt.getTime() > UNDO_DAYS * 86400_000) throw bad("Too old to undo", { tooOld: true });

  const p = await plan(row, user, projectId);
  return { row, projectId, p };
}

async function conflictError(row: Awaited<ReturnType<typeof prepare>>["row"], p: Plan, userId: string) {
  const later = await db.actionLog.findMany({ where: { targetType: row.targetType, targetId: row.targetId, createdAt: { gt: row.createdAt }, id: { not: row.id } }, include: { actor: { select: { name: true } } } });
  return bad("This changed after your action.", {
    needsConfirm: "conflict",
    label: UNDO_LABELS[row.action],
    changedBy: [...new Set(later.filter((l) => l.actorId !== userId).map((l) => l.actor.name))],
    conflicts: await present(p.conflicts),
  });
}

/** Everything undoAction checks, with nothing written. Used to test a whole concierge card before reversing any of it. */
export async function checkUndo(user: Actor, logId: string) {
  const { row, p } = await prepare(user, logId);
  if (p.conflicts.length) throw await conflictError(row, p, user.id);
}

/**
 * Undo one logged action. Returns what happened; throws 409 with the three values when the data changed since,
 * unless `anyway` is set, in which case only the fields the action touched are reverted (AC3).
 */
export async function undoAction(user: Actor, logId: string, anyway = false) {
  const { row, projectId, p } = await prepare(user, logId);
  if (p.conflicts.length && !anyway) throw await conflictError(row, p, user.id);

  // Deleting and restoring have their own transactions.
  if (row.action === "task.deleted") await restoreTask(user, row.targetId, true, { byUndo: true });
  if (row.action === "task.restored" || row.action === "task.created") await deleteTask(user, row.targetId, { byUndo: true });

  await db.$transaction(async (tx) => {
    await p.apply(tx);
    await tx.actionLog.update({ where: { id: row.id }, data: { undoneAt: new Date(), undoneById: user.id } });
    await logAction(tx, {
      actorId: user.id, projectId, targetType: row.targetType as "task", targetId: row.targetId, action: "undo",
      before: { undoes: row.id, action: row.action }, after: { undoes: row.id, label: UNDO_LABELS[row.action], anyway: anyway && p.conflicts.length > 0 },
    });
    if (anyway && p.conflicts.length) {
      const later = await tx.actionLog.findMany({ where: { targetType: row.targetType, targetId: row.targetId, createdAt: { gt: row.createdAt }, id: { not: row.id }, actorId: { not: user.id } }, select: { actorId: true } });
      await notify(tx, later.map((l) => l.actorId), "CHANGE_OVERRIDDEN", {
        actorId: user.id, projectId, taskId: row.targetType === "task" ? row.targetId : undefined, data: { title: p.subject, fields: p.fields },
      });
      await auditTx(tx, "UNDO_OVERRIDE", { actorId: user.id, targetId: row.targetId, targetType: row.targetType, data: { projectId, action: row.action } });
    }
  });
  return { label: UNDO_LABELS[row.action], noticesSent: NOTIFYING.has(row.action), overrode: anyway && p.conflicts.length > 0 };
}
