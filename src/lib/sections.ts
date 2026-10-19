import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { projectAccess, requireManage, type Actor, type Tx } from "@/lib/access";
import { logAction } from "@/lib/notify";
import { cascadedSubtaskIds } from "@/lib/tasks";

const MAX_SECTIONS = 8;

async function sectionIn(projectId: string, sectionId: string) {
  const s = await db.section.findFirst({ where: { id: sectionId, projectId } });
  if (!s) throw notFound("Section");
  return s;
}

/**
 * A parent closed by a Section change takes its open subtasks with it, one log row each, exactly as
 * completeTask does (SHO-BUG-3): a complete parent never has an open subtask. Returns the subtask ids.
 */
async function completeSubtasks(tx: Tx, o: { projectId: string; actorId: string; parentIds: string[]; now: Date; via: Record<string, unknown> }) {
  if (!o.parentIds.length) return [] as string[];
  const subs = await tx.task.findMany({ where: { parentId: { in: o.parentIds }, completedAt: null, deletedAt: null }, select: { id: true, parentId: true } });
  if (!subs.length) return [] as string[];
  await tx.task.updateMany({ where: { id: { in: subs.map((s) => s.id) } }, data: { completedAt: o.now } });
  for (const s of subs) {
    await logAction(tx, { actorId: o.actorId, projectId: o.projectId, targetType: "task", targetId: s.id, action: "task.completed", before: { completedAt: null }, after: { completedAt: o.now.toISOString(), withParent: s.parentId, ...o.via }, primary: false });
  }
  return subs.map((s) => s.id);
}

/** SHO-US-5.4 AC1/AC5. Appended at the end. */
export async function addSection(user: Actor, projectId: string, name: string) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const existing = await db.section.count({ where: { projectId } });
  if (existing >= MAX_SECTIONS) throw new ApiError(409, "A project can have up to 8 sections.");
  return db.$transaction(async (tx) => {
    const s = await tx.section.create({ data: { projectId, name, position: existing } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "section", targetId: s.id, action: "section.added", after: { name, position: existing } });
    return s;
  });
}

/** Rename, move left or right, or mark as the done Section. */
export async function updateSection(
  user: Actor,
  projectId: string,
  sectionId: string,
  input: { name?: string; move?: "left" | "right"; isDone?: boolean },
) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const s = await sectionIn(projectId, sectionId);
  if (input.isDone === false && s.isDone) {
    throw new ApiError(409, "Mark another section as the done section first.");
  }
  await db.$transaction(async (tx) => {
    if (input.name !== undefined) {
      await tx.section.update({ where: { id: s.id }, data: { name: input.name } });
      await logAction(tx, { actorId: user.id, projectId, targetType: "section", targetId: s.id, action: "section.renamed", before: { name: s.name }, after: { name: input.name } });
    }
    if (input.move) {
      const all = await tx.section.findMany({ where: { projectId }, orderBy: { position: "asc" } });
      const i = all.findIndex((x) => x.id === s.id);
      const j = input.move === "left" ? i - 1 : i + 1;
      if (j >= 0 && j < all.length) {
        [all[i], all[j]] = [all[j], all[i]];
        for (const [pos, sec] of all.entries()) await tx.section.update({ where: { id: sec.id }, data: { position: pos } });
        await logAction(tx, { actorId: user.id, projectId, targetType: "section", targetId: s.id, action: "section.moved", before: { position: i }, after: { move: input.move, position: j } });
      }
    }
    if (input.isDone && !s.isDone) {
      // Completion follows the done Section: tasks in the new one become complete, tasks in the old one reopen.
      const open = await tx.task.findMany({ where: { sectionId: s.id, completedAt: null, deletedAt: null, approverId: { not: null }, parentId: null } });
      if (open.length) throw new ApiError(409, "Tasks waiting on an approver are in that section; close or move them first.");
      const old = await tx.section.findFirst({ where: { projectId, isDone: true } });
      let reopened: string[] = [];
      // Cascaded subtasks reopen with the parent. A subtask ticked on its own, and any parent in Trash, stay as they are (APL-2721).
      let reopenedSubtaskIds: string[] = [];
      if (old) {
        const parents = await tx.task.findMany({
          where: { sectionId: old.id, parentId: null, completedAt: { not: null }, deletedAt: null },
          select: { id: true, completedAt: true },
        });
        reopened = parents.map((x) => x.id);
        reopenedSubtaskIds = await cascadedSubtaskIds(tx, projectId, parents);
        await tx.section.update({ where: { id: old.id }, data: { isDone: false } });
        const opening = [...reopened, ...reopenedSubtaskIds];
        if (opening.length) await tx.task.updateMany({ where: { id: { in: opening } }, data: { completedAt: null } });
      }
      const now = new Date();
      const completed = (await tx.task.findMany({ where: { sectionId: s.id, parentId: null, completedAt: null, deletedAt: null }, select: { id: true } })).map((x) => x.id);
      await tx.section.update({ where: { id: s.id }, data: { isDone: true } });
      await tx.task.updateMany({ where: { id: { in: completed } }, data: { completedAt: now } });
      // One row per task that closed, and their open subtasks close with them (SHO-BUG-3), so the log shows every write.
      const subtasks = await completeSubtasks(tx, { projectId, actorId: user.id, parentIds: completed, now, via: { viaDoneSection: true } });
      for (const id of completed) {
        await logAction(tx, { actorId: user.id, projectId, targetType: "task", targetId: id, action: "task.completed", before: { completedAt: null }, after: { completedAt: now.toISOString(), viaDoneSection: true }, primary: false });
      }
      await logAction(tx, {
        actorId: user.id, projectId, targetType: "section", targetId: s.id, action: "section.done_changed",
        // Every id is kept. Cutting the lists at 200 made Undo skip the rest and still succeed (APL-2680).
        before: { doneSectionId: old?.id ?? null, reopenedTaskIds: reopened, reopenedSubtaskIds },
        after: { doneSectionId: s.id, completedTaskIds: completed, completedSubtaskIds: subtasks, reopened: reopened.length, completed: completed.length, completedSubtasks: subtasks.length, reopenedSubtasks: reopenedSubtaskIds.length },
      });
    }
  });
}

/** SHO-US-5.4 AC2/AC6. The tasks must go somewhere; the done Section and the last Section are protected. */
export async function deleteSection(user: Actor, projectId: string, sectionId: string, moveTo?: string) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const s = await sectionIn(projectId, sectionId);
  if (s.isDone) throw new ApiError(409, "Mark another section as the done section before deleting this one.");
  if ((await db.section.count({ where: { projectId } })) <= 1) throw new ApiError(409, "The last section cannot be deleted.");
  if (!moveTo || moveTo === sectionId) throw new ApiError(400, "Choose another section to receive this section's tasks.");
  const dest = await sectionIn(projectId, moveTo);
  await db.$transaction(async (tx) => {
    const tasks = await tx.task.findMany({ where: { sectionId } });
    if (dest.isDone && tasks.some((t) => t.approverId && !t.completedAt && !t.deletedAt && !t.parentId)) {
      throw new ApiError(409, "Some tasks wait on an approver. Choose a section that is not the done section.");
    }
    const now = new Date();
    const closing = dest.isDone ? tasks.filter((t) => !t.parentId && !t.completedAt && !t.deletedAt) : [];
    await tx.task.updateMany({ where: { sectionId }, data: { sectionId: dest.id } });
    if (dest.isDone) await tx.task.updateMany({ where: { sectionId: dest.id, parentId: null, completedAt: null, deletedAt: null }, data: { completedAt: now } });
    // Open subtasks of a parent that closed here close with it, one row each (SHO-BUG-3).
    await completeSubtasks(tx, { projectId, actorId: user.id, parentIds: closing.map((t) => t.id), now, via: { viaSectionDelete: true } });
    // One row per task that moved (and per task that closed because of it), so the log shows every write.
    for (const t of tasks.filter((x) => !x.parentId)) {
      await logAction(tx, { actorId: user.id, projectId, targetType: "task", targetId: t.id, action: "task.moved", before: { sectionId }, after: { sectionId: dest.id, viaSectionDelete: true }, primary: false });
    }
    for (const t of closing) {
      await logAction(tx, { actorId: user.id, projectId, targetType: "task", targetId: t.id, action: "task.completed", before: { completedAt: null }, after: { completedAt: now.toISOString(), viaSectionDelete: true }, primary: false });
    }
    await tx.section.delete({ where: { id: sectionId } });
    const rest = await tx.section.findMany({ where: { projectId }, orderBy: { position: "asc" } });
    for (const [pos, sec] of rest.entries()) await tx.section.update({ where: { id: sec.id }, data: { position: pos } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "section", targetId: sectionId, action: "section.deleted", before: { name: s.name }, after: { movedTo: dest.id, tasks: tasks.length } });
  });
}
