// SHO-US-14.11: change several tasks of one project in one request, and take them all back with one Undo.
// Every task goes through the same function a single edit uses, so the same rules apply to each one.
// A task that may not be changed is skipped and named in the answer; nothing is ever changed without being reported.
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { WORKERS, activeMember, projectAccess, requireWrite, type Actor } from "@/lib/access";
import { formatDueDate, parseDueDate } from "@/lib/dates";
import { notify } from "@/lib/notify";
import { reqCtx } from "@/lib/reqctx";
import { assignTask, completeTask, moveTask, updateTask } from "@/lib/tasks";
import { checkUndo, undoAction } from "@/lib/undo";
import { isUndoable } from "@/lib/undoable";

export const BULK_MAX = 50;

export const bulkInput = z.object({
  taskIds: z.array(z.string().min(1)).min(1, "Select at least one task."),
  action: z.enum(["assign", "date", "move", "complete"]),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.").nullable().optional(),
  sectionId: z.string().min(1).optional(),
  // APL-2668: the updatedAt the page showed for each selected task. Required for assign, move and complete.
  versions: z.record(z.string(), z.string()).optional(),
});
type Input = z.infer<typeof bulkInput>;

const NOUN: Record<Input["action"], string> = { assign: "reassigned", date: "given a new date", move: "moved", complete: "completed" };

export async function bulkChange(user: Actor, projectId: string, input: Input) {
  const ids = [...new Set(input.taskIds)];
  if (ids.length > BULK_MAX) throw new ApiError(400, `You can change up to ${BULK_MAX} tasks at once. You selected ${ids.length}. Select fewer and try again.`, { tooMany: true, max: BULK_MAX });
  const a = await projectAccess(user, projectId, { write: true });
  requireWrite(a);
  // APL-2668: every task says which version the page showed, or nothing is changed.
  if (input.action !== "date" && ids.some((id) => !input.versions?.[id])) throw new ApiError(400, "expectedUpdatedAt is required");

  // Check the target once, for everyone: a bad target fails the whole request before anything changes.
  if (input.action === "assign") {
    if (!input.assigneeId) throw new ApiError(400, "Choose who the tasks go to.");
    const m = await db.$transaction((tx) => activeMember(tx, projectId, input.assigneeId!, WORKERS));
    if (!m) throw new ApiError(400, "The assignee must be an active Leader or Editor of this project.");
  }
  if (input.action === "date" && input.dueDate === undefined) throw new ApiError(400, "Choose a date, or clear the date.");
  if (input.action === "date" && input.dueDate) parseDueDate(input.dueDate);
  if (input.action === "move") {
    if (!input.sectionId) throw new ApiError(400, "Choose a section.");
    const s = await db.section.findFirst({ where: { id: input.sectionId, projectId } });
    if (!s) throw new ApiError(404, "Section not found");
  }

  const rows = await db.task.findMany({ where: { id: { in: ids }, projectId, deletedAt: null, parentId: null } });
  const byId = new Map(rows.map((t) => [t.id, t]));
  const ctx = reqCtx.getStore();
  const before = ctx?.logIds?.length ?? 0;
  if (ctx) { ctx.logIds = ctx.logIds ?? []; ctx.muteNotify = true; }

  const changed: typeof rows = [];
  const skipped: { id: string; title: string; reason: string }[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) { skipped.push({ id, title: "A task", reason: "not found" }); continue; }
    try {
      if (input.action === "assign") {
        if (t.assigneeId === input.assigneeId) { skipped.push({ id, title: t.title, reason: "already up to date" }); continue; }
        await assignTask(user, id, input.assigneeId!, input.versions![id]);
      } else if (input.action === "date") {
        if ((formatDueDate(t.dueDate) ?? null) === (input.dueDate ?? null)) { skipped.push({ id, title: t.title, reason: "already up to date" }); continue; }
        await updateTask(user, id, { dueDate: input.dueDate ?? null, expectedUpdatedAt: t.updatedAt.toISOString() });
      } else if (input.action === "move") {
        if (t.sectionId === input.sectionId) { skipped.push({ id, title: t.title, reason: "already up to date" }); continue; }
        await moveTask(user, id, input.sectionId!, input.versions![id]);
      } else {
        if (t.completedAt) { skipped.push({ id, title: t.title, reason: "already complete" }); continue; }
        await completeTask(user, id, input.versions![id], false);
      }
      changed.push(t);
    } catch (e) {
      // Whatever went wrong, this task is named as skipped; the others carry on.
      const reason = e instanceof ApiError
        ? (e.status === 403 ? "no permission" : e.extra?.stale ? "changed by someone else" : e.extra?.needsConfirm === "open_subtasks" ? "has open subtasks" : e.status === 404 ? "not found" : "could not be changed")
        : "could not be changed";
      skipped.push({ id, title: t.title, reason });
    }
  }
  if (ctx) ctx.muteNotify = false;

  if (input.action === "assign" && changed.length) await noticesFor(user, projectId, a.project.name, input.assigneeId!, changed);

  // One Undo for the lot. Subtasks completed with their parent come back with the parent's own row.
  const logIds = (ctx?.logIds ?? []).slice(before);
  const logRows = logIds.length ? await db.actionLog.findMany({ where: { id: { in: logIds } }, select: { id: true, action: true, afterState: true } }) : [];
  const undoIds = logRows.filter((r) => isUndoable(r.action) && !(r.action === "task.completed" && (r.afterState as { withParent?: string } | null)?.withParent)).map((r) => r.id);
  if (ctx) { ctx.undoId = undefined; ctx.undoLabel = undefined; } // the page shows one toast for the whole group

  return {
    changed: changed.length,
    skipped,
    message: summary(changed.length, skipped),
    undoIds,
    label: changed.length ? `${changed.length} task${changed.length === 1 ? "" : "s"} ${NOUN[input.action]}` : null,
    notified: !!ctx?.notified,
  };
}

/** "4 changed, 1 skipped (no permission)". Several reasons are counted: "3 skipped (2 no permission, 1 has open subtasks)". */
export function summary(changed: number, skipped: { reason: string }[]) {
  if (!skipped.length) return `${changed} changed`;
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const why = counts.size === 1 ? [...counts.keys()][0] : [...counts].map(([r, n]) => `${n} ${r}`).join(", ");
  return `${changed ? `${changed} changed, ` : "Nothing changed: "}${skipped.length} skipped (${why})`;
}

/** SHO-US-14.11 AC2: the new assignee hears once, and each person who lost tasks hears once, however many tasks moved. */
async function noticesFor(user: Actor, projectId: string, projectName: string, assigneeId: string, changed: { id: string; title: string; assigneeId: string }[]) {
  await db.$transaction(async (tx) => {
    const one = changed.length === 1 ? changed[0] : null;
    await notify(tx, [assigneeId], one ? "TASK_ASSIGNED" : "TASKS_REASSIGNED", {
      actorId: user.id, projectId, taskId: one?.id, data: one ? { title: one.title } : { count: changed.length, project: projectName },
    });
    const lost = new Map<string, typeof changed>();
    for (const t of changed) lost.set(t.assigneeId, [...(lost.get(t.assigneeId) ?? []), t]);
    for (const [who, list] of lost) {
      if (who === assigneeId) continue;
      const first = list.length === 1 ? list[0] : null;
      await notify(tx, [who], first ? "REMOVED_AS_ASSIGNEE" : "TASKS_REASSIGNED_SUMMARY", {
        actorId: user.id, projectId, taskId: first?.id, data: first ? { title: first.title } : { count: list.length, project: projectName },
      });
    }
  });
}

/** One lookup page. Postgres binds one parameter per id; paging reads a long batch without dropping the tail (APL-2680). */
const UNDO_LOOKUP_CHUNK = 500;

/**
 * Rows still open for Undo, newest first. Already-reversed rows are left out so a retry finishes the rest.
 * Every requested id is looked up; the old `slice(0, 500)` skipped the rest and still reported success.
 */
async function loadOpenUndoRows(ids: string[]) {
  const unique = [...new Set(ids)];
  const rows: Awaited<ReturnType<typeof db.actionLog.findMany>> = [];
  for (let i = 0; i < unique.length; i += UNDO_LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + UNDO_LOOKUP_CHUNK);
    rows.push(...await db.actionLog.findMany({ where: { id: { in: chunk }, undoneAt: null } }));
  }
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return rows;
}

/** APL-2875: a row in a project the caller cannot see is skipped like a missing id, so the answer does not reveal it exists. */
async function canSee(user: Actor, projectId: string | null) {
  if (!projectId) return true;
  try {
    await projectAccess(user, projectId);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return false;
    throw e;
  }
}

/** One Undo for a whole bulk change. All of it is checked first; rows already reversed are skipped, so a retry finishes the rest. */
export async function undoMany(user: Actor, ids: string[], anyway = false) {
  const rows = await loadOpenUndoRows(ids);
  const seen = new Map<string, boolean>();
  const todo = [];
  for (const r of rows) {
    if (!isUndoable(r.action)) continue;
    const key = r.projectId ?? "";
    if (!seen.has(key)) seen.set(key, await canSee(user, r.projectId));
    if (seen.get(key)) todo.push(r);
  }
  if (!todo.length) throw new ApiError(409, "This was already undone.");
  if (!anyway) for (const r of todo) await checkUndo(user, r.id);
  let noticed = false;
  for (const r of todo) noticed = (await undoAction(user, r.id, anyway)).noticesSent || noticed;
  return { label: `${todo.length} task${todo.length === 1 ? "" : "s"} put back`, noticesSent: noticed, count: todo.length };
}
