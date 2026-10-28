/* eslint-disable @typescript-eslint/no-explicit-any */
// SHO-US-6.4: Undo from the stored before-state, with a conflict warning and "Undo anyway".
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { WORKERS, activeMember, isAdmin, requireManage, requireWrite, type Actor, type Tx } from "@/lib/access";
import { formatDueDate } from "@/lib/dates";
import { auditTx, logAction, notify } from "@/lib/notify";
import { deleteTask, recordAccess, restoreTask } from "@/lib/tasks";
import { UNDO_LABELS, isTooOldToUndo, isUndoable } from "@/lib/undoable";
import { undoRecord } from "@/lib/records";
import { commentsEnabled, isCommentAction } from "@/lib/flags";
import { assertCommentRoom } from "@/lib/comments";

type Conflict = { field: string; before: unknown; after: unknown; now: unknown };
type Plan = { conflicts: Conflict[]; apply: (tx: Tx) => Promise<void>; subject?: string; fields?: string };

const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const bad = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, msg, extra);
/** The 200-comment cap on an Undo restore is a conflict with the task's current state: 409, same message and code (AC17). */
const roomForRestore = (client: Tx | typeof db, taskId: string, lock = false) =>
  assertCommentRoom(client, taskId, lock).catch((e: unknown) => {
    throw e instanceof ApiError && e.extra?.code === "too_many_comments" ? bad(e.message, e.extra) : e;
  });

/** Actions that sent a bell notice, so Undo can say the notice was already delivered (AC4). */
const NOTIFYING = new Set([
  "task.created", "task.assigned", "task.sent_for_approval", "task.sent_back", "task.approver_changed", "task.collaborator_added",
  "task.collaborator_removed", "task.deleted", "project.archived", "member.added", "member.removed", "member.role_changed", "project.leader_changed",
  "comment.added",
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

/**
 * A done-section row stores a full count beside each id list. A list shorter than its count was
 * capped, and applying it would restore only the listed tasks. Refuse instead (APL-2680).
 * `reopenedSubtaskIds` is written by the reopen-with-parent change; older rows simply omit it.
 */
function refuseShortDoneLists(before: Record<string, unknown>, after: Record<string, unknown>) {
  const gap = (label: string, ids: unknown, total: unknown) => {
    if (typeof total !== "number" || !Number.isFinite(total)) return null;
    const listed = Array.isArray(ids) ? ids.length : 0;
    return total > listed ? `${listed} of ${total} ${label}` : null;
  };
  const gaps = [
    gap("reopened tasks", before.reopenedTaskIds, after.reopened),
    gap("completed tasks", after.completedTaskIds, after.completed),
    gap("completed subtasks", after.completedSubtaskIds, after.completedSubtasks),
    gap("reopened subtasks", before.reopenedSubtaskIds, after.reopenedSubtasks),
  ].filter((x): x is string => !!x);
  if (gaps.length) throw bad(`Undo was not applied. This record lists only ${gaps.join(", ")}, so nothing was changed.`);
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
      // A send-back that cleared the approver (SHO-BUG-6) recorded it, so Undo puts the approver back too.
      const keys = "approverId" in f ? ["assigneeId", "approverId"] : ["assigneeId"];
      return {
        conflicts: fieldConflicts(keys, b, f, { assigneeId: t.assigneeId, approverId: t.approverId }), subject: t.title, fields: "Assignee",
        apply: async (tx) => {
          if (!(await activeMember(tx, projectId, b.assigneeId, WORKERS))) throw bad("The previous assignee can no longer take this task.");
          if ("approverId" in f && b.approverId && !(await activeMember(tx, projectId, b.approverId, WORKERS))) throw bad("The previous approver can no longer take that role.");
          await tx.task.update({ where: { id }, data: { assigneeId: b.assigneeId, previousAssigneeId: b.previousAssigneeId ?? null, ...("approverId" in f ? { approverId: b.approverId ?? null } : {}) } });
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
          const stamp = new Date(b.completedAt ?? Date.now());
          if (t.parentId) { await tx.task.update({ where: { id }, data: { completedAt: stamp } }); return; }
          const done = await tx.section.findFirstOrThrow({ where: { projectId, isDone: true } });
          await tx.task.update({ where: { id }, data: { completedAt: stamp, sectionId: done.id, previousSectionId: t.sectionId } });
          // Subtasks that reopened with the parent close with it again, on the same completedAt (APL-2721).
          // One ticked done on its own since then keeps its own completedAt. One moved to Trash since closes too:
          // the reopen never lists a subtask that was already in Trash, so these ids are only ones it changed (APL-2870).
          if (Array.isArray(f.subtaskIds) && f.subtaskIds.length) await tx.task.updateMany({ where: { id: { in: f.subtaskIds }, completedAt: null }, data: { completedAt: stamp } });
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
    case "comment.added": {
      const commentId = String(f.commentId ?? "");
      const c = await db.comment.findUnique({ where: { id: commentId } });
      if (!c) throw bad("This comment no longer exists.");
      if (c.removedAt) throw bad("This comment is already deleted.");
      const task = await liveTask(id, projectId);
      return { conflicts: [], subject: task.title, apply: async (tx) => { await tx.comment.update({ where: { id: commentId }, data: { removedAt: new Date() } }); } };
    }
    case "comment.removed": {
      const commentId = String(f.commentId ?? "");
      const c = await db.comment.findUnique({ where: { id: commentId } });
      if (!c) throw bad("This comment no longer exists.");
      if (!c.removedAt) throw bad("This comment is already back.");
      const task = await liveTask(id, projectId);
      await roomForRestore(db, c.taskId); // APL-2840: at 200 live comments the restore is refused with the cap message (409)
      return {
        conflicts: [], subject: task.title,
        apply: async (tx) => {
          await roomForRestore(tx, c.taskId, true);
          await tx.comment.update({ where: { id: commentId }, data: { removedAt: null } });
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
    case "deal.stage_changed": {
      // project-lookup-ok: Undo preparation already authorizes the action project through recordAccess before planning.
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      // Retired stages remain valid historical targets. Normal moves reject them; Undo preserves the original ID.
      if (!b.stageId || !(await db.stage.findFirst({ where: { id: b.stageId, pipelineId: p.pipelineId ?? "" } }))) throw bad("The earlier stage no longer exists.");
      return {
        conflicts: p.stageId !== f.stageId ? [{ field: "stage", before: b.stage, after: f.stage, now: p.stageId }] : [], subject: p.name, fields: "Stage",
        apply: async (tx) => {
          const changed = await tx.project.updateMany({ where: { id: projectId, pipelineId: p.pipelineId, stageId: p.stageId, updatedAt: p.updatedAt }, data: { stageId: b.stageId, stageReason: b.reason ?? null, stageChangedAt: new Date() } });
          if (!changed.count) throw bad("This deal changed. Refresh before undoing its stage.");
        },
      };
    }
    case "deal.converted": {
      // Undo returns the task and its subtasks to their original project and Section, and archives the new deal (12.2 AC4).
      const task = await db.task.findUnique({ where: { id }, include: { project: true } });
      if (!task || task.projectId !== projectId) throw bad("The task is no longer in this deal, so the conversion cannot be undone.");
      if (task.deletedAt) throw bad("The task is in Trash. Restore it first.");
      // project-lookup-ok: Original source ID comes from the authorized conversion before-state; task is verified against the current project.
      const src = await db.project.findUnique({ where: { id: b.sourceProjectId } });
      if (!src) throw bad("The original project no longer exists.");
      if (src.archivedAt) throw bad("The original project is archived. Unarchive it first.");
      return {
        conflicts: [], subject: task.title,
        apply: async (tx) => {
          const sec = (await tx.section.findFirst({ where: { id: b.sectionId, projectId: src.id } })) ?? (await tx.section.findFirstOrThrow({ where: { projectId: src.id, isDone: false }, orderBy: { position: "asc" } }));
          await tx.task.update({ where: { id }, data: { projectId: src.id, sectionId: sec.id, previousSectionId: b.previousSectionId ?? null, isIdea: !!b.isIdea } });
          if (Array.isArray(b.subtaskIds) && b.subtaskIds.length) await tx.task.updateMany({ where: { id: { in: b.subtaskIds } }, data: { projectId: src.id, sectionId: sec.id } });
          await tx.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
        },
      };
    }
    case "task.link_added": {
      const l = await db.taskLink.findUnique({ where: { id: f.linkId } });
      if (!l) throw bad("That link is already gone.");
      return { conflicts: [], subject: "the link", apply: async (tx) => { await tx.taskLink.delete({ where: { id: f.linkId } }); } };
    }
    case "task.link_removed": {
      const t = await liveTask(id, projectId);
      if (await db.taskLink.findFirst({ where: { taskId: id, organisationId: b.organisationId ?? null, contactId: b.contactId ?? null } })) throw bad("That link is back already.");
      return { conflicts: [], subject: t.title, apply: async (tx) => { await tx.taskLink.create({ data: { id: b.linkId, taskId: id, organisationId: b.organisationId ?? null, contactId: b.contactId ?? null } }); } };
    }
    case "task.idea_changed": {
      const t = await liveTask(id, projectId);
      return {
        conflicts: t.isIdea !== f.isIdea ? [{ field: "isIdea", before: b.isIdea, after: f.isIdea, now: t.isIdea }] : [], subject: t.title, fields: "Idea",
        apply: async (tx) => { await tx.task.update({ where: { id }, data: { isIdea: !!b.isIdea } }); },
      };
    }
    case "deal.details_updated": {
      // project-lookup-ok: prepare authorizes recordAccess before preparing this guarded undo
      const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      const d = await db.dealDetails.findUnique({ where: { projectId } });
      if (!d) throw bad("This deal no longer exists.");
      const keys = Object.keys(f);
      const now: Record<string, unknown> = {
        whyPursue: d.whyPursue, need: d.need, serviceLine: d.serviceLine, value: d.value === null ? null : Number(d.value), currency: d.currency,
        probability: d.probability, expectedClose: d.expectedClose?.toISOString().slice(0, 10) ?? null, introducedBy: d.introducedBy,
        submissionDeadline: d.submissionDeadline?.toISOString().slice(0, 10) ?? null,
      };
      const data: Record<string, unknown> = {};
      for (const k of keys) data[k] = (k === "expectedClose" || k === "submissionDeadline") && b[k] ? new Date(`${b[k]}T00:00:00Z`) : b[k] ?? null;
      return { conflicts: fieldConflicts(keys, b, f, now), subject: "the deal", fields: keys.join(", "), apply: async (tx) => {
        const changed = await tx.project.updateMany({ where: { id: projectId, pipelineId: project.pipelineId, updatedAt: project.updatedAt }, data: { updatedAt: new Date() } });
        if (!changed.count) throw bad("This deal changed. Refresh before undoing its details.");
        await tx.dealDetails.update({ where: { projectId }, data });
      } };
    }
    case "project.updated": {
      // project-lookup-ok: Undo preparation already authorizes this exact project through recordAccess before planning.
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      const keys = Object.keys(f);
      if (p.isVertical && keys.includes("name") && !isAdmin(user)) throw new ApiError(403, "Only Admins rename verticals.");
      if (p.isVertical && keys.includes("verticalId")) throw new ApiError(409, "A vertical board cannot belong to another vertical.");
      return { conflicts: fieldConflicts(keys, b, f, { name: p.name, description: p.description, verticalId: p.verticalId }), subject: p.name, fields: keys.join(", "), apply: async (tx) => { await tx.project.update({ where: { id: projectId }, data: Object.fromEntries(keys.map((k) => [k, b[k]])) }); } };
    }
    case "project.archived": {
      // project-lookup-ok: Undo preparation already authorizes this exact project through recordAccess before planning.
      const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      if (!p.archivedAt) throw bad("This project is not archived any more.");
      return { conflicts: [], subject: p.name, apply: async (tx) => { await tx.project.update({ where: { id: projectId }, data: { archivedAt: null } }); } };
    }
    case "project.unarchived": {
      // project-lookup-ok: Undo preparation already authorizes this exact project through recordAccess before planning.
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
      refuseShortDoneLists(b, f);
      return {
        conflicts: cur && cur.id !== f.doneSectionId ? [{ field: "sectionId", before: b.doneSectionId, after: f.doneSectionId, now: cur.id }] : [], subject: "the done section", fields: "Done section",
        apply: async (tx) => {
          if (cur) await tx.section.update({ where: { id: cur.id }, data: { isDone: false } });
          await tx.section.update({ where: { id: b.doneSectionId }, data: { isDone: true } });
          // Parents closed by the change reopen, and so do the subtasks that closed with them (SHO-BUG-3).
          const closed = [...(Array.isArray(f.completedTaskIds) ? f.completedTaskIds : []), ...(Array.isArray(f.completedSubtaskIds) ? f.completedSubtaskIds : [])];
          if (closed.length) await tx.task.updateMany({ where: { id: { in: closed } }, data: { completedAt: null } });
          // One stamp, so a later move still treats these subtasks as closed with the parent (APL-2721).
          // Every task the move reopened closes again, also one moved to Trash since: the move never lists a task
          // that was already in Trash, so these ids are only tasks it changed (APL-2755).
          const stamp = new Date();
          if (Array.isArray(b.reopenedTaskIds) && b.reopenedTaskIds.length) await tx.task.updateMany({ where: { id: { in: b.reopenedTaskIds }, completedAt: null }, data: { completedAt: stamp } });
          if (Array.isArray(b.reopenedSubtaskIds) && b.reopenedSubtaskIds.length) await tx.task.updateMany({ where: { id: { in: b.reopenedSubtaskIds }, completedAt: null }, data: { completedAt: stamp } });
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
  if (!row) throw notFound("Action");
  // APL-2590 D1: with the comments switch off, a comment row is the same 404 as an action that does not exist.
  if (isCommentAction(row.action) && !commentsEnabled()) throw notFound("Action");
  const projectId = row.projectId;
  if (!projectId) throw bad("This kind of action cannot be undone.");
  const a = await recordAccess(user, projectId, "Action");
  requireWrite(a);
  const archiveKind = row.action === "project.archived" || row.action === "project.unarchived";
  if (a.project.archivedAt && !archiveKind) throw new ApiError(409, "This project is archived and read-only.");
  if (row.actorId !== user.id && a.role !== "LEADER") throw new ApiError(403, "You can only undo your own actions.");
  // Already undone wins over the Leader/Admin check (APL-2655). An Editor who deleted the task
  // otherwise gets 403 after a Leader has already undone that delete.
  if (row.action === "task.deleted" && row.undoneAt) throw bad("This was already undone.");
  // Undoing a delete is a restore from Trash, so it takes the same Leader or Admin check (SHO-US-6.2 AC4, SHO-BUG-8).
  if (row.action === "task.deleted") requireManage(a);
  if (row.undoneAt) throw bad("This action was already undone.");
  if (!isUndoable(row.action)) throw bad("This kind of action cannot be undone.");
  if (isTooOldToUndo(row.createdAt)) throw bad("Too old to undo", { tooOld: true });

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
  const own = await db.actionLog.findUnique({ where: { id: logId }, select: { projectId: true } });
  if (own && !own.projectId) return; // organisation, contact and note rows are never part of a concierge card
  const { row, p } = await prepare(user, logId);
  if (p.conflicts.length) throw await conflictError(row, p, user.id);
}

/**
 * Undo one logged action. Returns what happened; throws 409 with the three values when the data changed since,
 * unless `anyway` is set, in which case only the fields the action touched are reverted (AC3).
 */
export async function undoAction(user: Actor, logId: string, anyway = false) {
  const rec = await db.actionLog.findUnique({ where: { id: logId } });
  if (rec && !rec.projectId) return undoRecord(user, rec, anyway); // organisations, contacts and notes belong to no project
  const { row, projectId, p } = await prepare(user, logId);
  if (p.conflicts.length && !anyway) throw await conflictError(row, p, user.id);

  // Deleting and restoring have their own transactions.
  if (row.action === "task.deleted") await restoreTask(user, row.targetId, true, { skipRestoredLog: true }); // Undo logs its own row
  if (row.action === "task.restored" || row.action === "task.created") await deleteTask(user, row.targetId, { byUndo: true });

  await db.$transaction(async (tx) => {
    await p.apply(tx);
    await tx.actionLog.update({ where: { id: row.id }, data: { undoneAt: new Date(), undoneById: user.id } });
    const commentId = (row.afterState as { commentId?: string } | null)?.commentId
      ?? (row.beforeState as { commentId?: string } | null)?.commentId;
    await logAction(tx, {
      actorId: user.id, projectId, targetType: row.targetType as "task", targetId: row.targetId, action: "undo",
      before: { undoes: row.id, action: row.action, ...(commentId ? { commentId } : {}) },
      after: { undoes: row.id, label: UNDO_LABELS[row.action], anyway: anyway && p.conflicts.length > 0, ...(commentId ? { commentId } : {}) },
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
