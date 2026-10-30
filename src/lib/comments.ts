// SHO-US-19.1: comments on tasks, with @mentions. Behind ff_task_comments.
// Notes stay on organisations and deals. Comment text stays on the comment row:
// notices, the action log and Activity carry the comment id and the task title, never the text.
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { canManage, isActive, projectAccess, requireWrite, type Actor, type Tx } from "@/lib/access";
import { commentsEnabled } from "@/lib/flags";
import { logAction, notify } from "@/lib/notify";
import { UNDO_DAYS, isTooOldToUndo } from "@/lib/undoable";

export const COMMENT_MAX = 5000;
export const COMMENTS_PER_TASK = 200;
export const MENTIONS_PER_COMMENT = 20;

const fail = (code: string, message: string) => new ApiError(400, message, { code });
const CAP_MESSAGE = "A task can have at most 200 comments.";

/**
 * Refuses when the task already has 200 live comments. Inside a transaction it first locks the task row,
 * so concurrent adds and Undo restores count one at a time (APL-2590 D3, APL-2840).
 */
export async function assertCommentRoom(client: Tx | typeof db, taskId: string, lock = false) {
  if (lock) await client.$queryRaw`SELECT 1 FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
  const live = await client.comment.count({ where: { taskId, removedAt: null } });
  if (live >= COMMENTS_PER_TASK) throw fail("too_many_comments", CAP_MESSAGE);
}

type Member = { id: string; name: string; role: string };

const awaiting = (t: { approverId: string | null; assigneeId: string; completedAt: Date | null }) =>
  !!t.approverId && t.assigneeId === t.approverId && !t.completedAt;

function requireFlag() {
  if (!commentsEnabled()) throw notFound();
}

async function activeMembers(projectId: string): Promise<Member[]> {
  const rows = await db.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { id: true, name: true, deactivatedAt: true, emailVerifiedAt: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.filter((m) => isActive(m.user)).map((m) => ({ id: m.user.id, name: m.user.name, role: m.role }));
}

async function openTask(user: Actor, taskId: string, write: boolean) {
  requireFlag();
  const t = await db.task.findUnique({ where: { id: taskId } });
  if (!t || t.deletedAt) throw notFound("Task");
  // A person who cannot see the project gets the same "Task not found" as a missing id (no existence leak).
  let a;
  try {
    // Write is checked here, not via projectAccess: an archived project answers 403 project_archived, not 409.
    a = await projectAccess(user, t.projectId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw notFound("Task");
    throw e;
  }
  if (write && a.project.archivedAt) throw new ApiError(403, "This project is archived and read-only.", { code: "project_archived" });
  if (write) requireWrite(a);
  const members = await activeMembers(t.projectId);
  return { t, a, members };
}

/** @Name matches, longest name first, plus explicit ids. Distinct. Unknown explicit ids still count toward the cap. */
export function resolveMentions(text: string, members: { id: string; name: string }[], explicit: string[] = []) {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== "@") continue;
    if (i > 0 && !/\s/.test(lower[i - 1])) continue;
    const rest = lower.slice(i + 1);
    const hit = byLength.find((m) => {
      const name = m.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const next = rest[name.length];
      return next === undefined || /[^a-z0-9]/i.test(next);
    });
    if (hit) found.add(hit.id);
  }
  const ids = new Set(members.map((m) => m.id));
  const attempted = new Set<string>(found);
  for (const id of explicit) attempted.add(id);
  const resolved = [...attempted].filter((id) => ids.has(id));
  return { resolved, attempted: attempted.size };
}

function presentOne(
  c: { id: string; text: string; authorId: string; mentions: string[]; editedAt: Date | null; createdAt: Date },
  names: Map<string, string>,
  user: Actor,
  canWrite: boolean,
  manage: boolean,
) {
  return {
    id: c.id,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    author: { id: c.authorId, name: names.get(c.authorId) ?? "Former member" },
    mentions: c.mentions.map((id) => ({ id, name: names.get(id) ?? "Former member" })),
    canEdit: canWrite && c.authorId === user.id,
    canDelete: canWrite && (c.authorId === user.id || manage),
  };
}

export async function listComments(user: Actor, taskId: string) {
  const { a, members } = await openTask(user, taskId, false);
  const rows = await db.comment.findMany({
    where: { taskId, removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: COMMENTS_PER_TASK,
  });
  const ids = [...new Set([...rows.flatMap((r) => [r.authorId, ...r.mentions]), ...members.map((m) => m.id)])];
  const people = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const names = new Map(people.map((p) => [p.id, p.name]));
  const canWrite = a.role !== "VIEWER" && !a.project.archivedAt;
  return {
    comments: rows.map((c) => presentOne(c, names, user, canWrite, canManage(a))),
    // The person writing the comment is its author, so the @ picker leaves them out.
    members: members.filter((m) => m.id !== user.id).map((m) => ({ id: m.id, name: m.name })),
    canComment: canWrite,
  };
}

async function notifyComment(tx: Tx, user: Actor, t: { id: string; projectId: string; title: string; assigneeId: string; approverId: string | null; previousAssigneeId: string | null; completedAt: Date | null }, mentionIds: string[]) {
  const data = { title: t.title };
  await notify(tx, mentionIds, "COMMENT_MENTION", { actorId: user.id, taskId: t.id, projectId: t.projectId, data });
  // While a task awaits approval the approver is the assignee. The original assignee is still told.
  const holders = [t.assigneeId];
  if (awaiting(t) && t.previousAssigneeId) holders.push(t.previousAssigneeId);
  await notify(tx, holders, "COMMENT_ADDED", { actorId: user.id, taskId: t.id, projectId: t.projectId, data });
}

export async function addComment(user: Actor, taskId: string, input: { text?: string | null; mentions?: string[] }) {
  const { t, members } = await openTask(user, taskId, true);
  const text = input.text ?? "";
  if (text.length > COMMENT_MAX) throw fail("comment_too_long", "A comment can be 5,000 characters at most.");
  const body = text.trim();
  if (!body) throw fail("comment_required", "Write a comment.");
  const { resolved, attempted } = resolveMentions(body, members, input.mentions ?? []);
  if (attempted > MENTIONS_PER_COMMENT) throw fail("too_many_mentions", "A comment can mention at most 20 people.");
  await assertCommentRoom(db, taskId);
  return db.$transaction(async (tx) => {
    await assertCommentRoom(tx, taskId, true); // APL-2590 D3: the locked count is the one that holds the cap
    const c = await tx.comment.create({
      data: { taskId, authorId: user.id, text: body, mentions: resolved },
    });
    await notifyComment(tx, user, t, resolved);
    await logAction(tx, {
      actorId: user.id, projectId: t.projectId, targetType: "task", targetId: t.id,
      action: "comment.added", after: { commentId: c.id },
    });
    return c;
  });
}

export async function editComment(user: Actor, taskId: string, commentId: string, input: { text?: string | null; mentions?: string[] }) {
  const { t, members } = await openTask(user, taskId, true);
  const c = await db.comment.findFirst({ where: { id: commentId, taskId, removedAt: null } });
  if (!c) throw notFound("Comment");
  if (c.authorId !== user.id) throw new ApiError(403, "Only the author can edit a comment.");
  const text = input.text ?? "";
  if (text.length > COMMENT_MAX) throw fail("comment_too_long", "A comment can be 5,000 characters at most.");
  const body = text.trim();
  if (!body) throw fail("comment_required", "Write a comment.");
  const { resolved, attempted } = resolveMentions(body, members, input.mentions ?? []);
  if (attempted > MENTIONS_PER_COMMENT) throw fail("too_many_mentions", "A comment can mention at most 20 people.");
  return db.$transaction(async (tx) => {
    const row = await tx.comment.update({ where: { id: c.id }, data: { text: body, mentions: resolved, editedAt: new Date() } });
    await logAction(tx, {
      actorId: user.id, projectId: t.projectId, targetType: "task", targetId: t.id,
      action: "comment.edited", after: { commentId: c.id },
    });
    return row;
  });
}

export async function removeComment(user: Actor, taskId: string, commentId: string) {
  const { t, a } = await openTask(user, taskId, true);
  const c = await db.comment.findFirst({ where: { id: commentId, taskId, removedAt: null } });
  if (!c) throw notFound("Comment");
  if (c.authorId !== user.id && !canManage(a)) throw new ApiError(403, "Only the author, the Leader or an Admin can delete a comment.");
  await db.$transaction(async (tx) => {
    await tx.comment.update({ where: { id: c.id }, data: { removedAt: new Date() } });
    await logAction(tx, {
      actorId: user.id, projectId: t.projectId, targetType: "task", targetId: t.id,
      action: "comment.removed", before: { commentId: c.id }, after: { commentId: c.id },
    });
  });
}

/** Live comment counts for list and board rows. With the flag off the rows are returned untouched. */
export async function attachCommentCounts<T extends { id: string }>(rows: T[]): Promise<Array<T & { commentCount?: number }>> {
  if (!commentsEnabled() || !rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const grouped = await db.comment.groupBy({
    by: ["taskId"],
    where: { taskId: { in: ids }, removedAt: null },
    _count: true,
  });
  const counts = new Map(grouped.map((g) => [g.taskId, g._count]));
  return rows.map((r) => ({ ...r, commentCount: counts.get(r.id) ?? 0 }));
}

export async function commentCount(taskId: string) {
  if (!commentsEnabled()) return undefined;
  return db.comment.count({ where: { taskId, removedAt: null } });
}

/**
 * Removes soft-deleted comments only when elapsed time is greater than 30×24h.
 * Exactly 30×24h stays, so Undo still restores them. `isTooOldToUndo` is the only decision.
 */
export async function purgeExpiredComments(now = new Date()) {
  const edge = new Date(now.getTime() - UNDO_DAYS * 86400_000);
  const rows = await db.comment.findMany({
    where: { removedAt: { lte: edge } },
    select: { id: true, removedAt: true },
  });
  const ids = rows.filter((r) => r.removedAt && isTooOldToUndo(r.removedAt, now.getTime())).map((r) => r.id);
  if (!ids.length) return 0;
  const r = await db.comment.deleteMany({ where: { id: { in: ids } } });
  return r.count;
}
