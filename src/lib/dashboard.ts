import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { crmProjectWhere, crmVisible, isAdmin, WORKSTREAM_PROJECT, type Actor } from "@/lib/access";
import { startOfTodayIST, formatDueDate } from "@/lib/dates";
import { idsIn, sentence, whenText } from "@/lib/activity-text";
import { commentsEnabled } from "@/lib/flags";
import { notFound } from "@/lib/http";

/** Dashboard is membership-scoped even for Admins; it summarizes the person's work. */
export function dashboardProjectScope(user: Actor): Prisma.ProjectWhereInput {
  return { deletedAt: null, archivedAt: null, members: { some: { userId: user.id } }, ...crmProjectWhere(user) };
}
export function ownOpenScope(user: Actor): Prisma.TaskWhereInput {
  return { deletedAt: null, completedAt: null, project: dashboardProjectScope(user), AND: [
    { OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
    { OR: [{ assigneeId: user.id }, { collaborators: { some: { userId: user.id } } }] },
  ] };
}
export function approvalScope(user: Actor): Prisma.TaskWhereInput {
  return { deletedAt: null, completedAt: null, parentId: null, assigneeId: user.id, approverId: user.id, project: {
    ...dashboardProjectScope(user),
    ...(isAdmin(user) ? {} : { OR: [
      { members: { some: { userId: user.id, role: { in: ["LEADER", "EDITOR"] } } } },
      { actionLogs: { some: { actorId: user.id, action: { in: ["project.created", "deal.created"] } } } },
    ] }),
  } };
}
const taskSelect = { id: true, title: true, dueDate: true, updatedAt: true, project: { select: { id: true, name: true } } } as const;
type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;
const shape = (t: TaskRow) => ({ id: t.id, title: t.title, dueDate: formatDueDate(t.dueDate), project: t.project });
export const completionPercent = (completed: number, total: number) => total > 0 ? Math.round(100 * completed / total) : 0;

async function approvalRows(tx: Prisma.TransactionClient, rows: TaskRow[], now: Date, userId: string) {
  const logs = rows.length ? await tx.$queryRaw<{ targetId: string; createdAt: Date }[]>(Prisma.sql`
    SELECT DISTINCT ON ("targetId") "targetId", "createdAt" FROM "ActionLog"
    WHERE "targetType" = 'task' AND "targetId" IN (${Prisma.join(rows.map(t => t.id))}) AND "undoneAt" IS NULL
    AND action IN ('task.sent_for_approval','task.assigned','task.approver_changed') AND "afterState"->>'assigneeId' = ${userId}
    ORDER BY "targetId", "createdAt" DESC, id DESC`) : [];
  const since = new Map(logs.map(l => [l.targetId, l.createdAt]));
  return rows.map(t => ({ ...shape(t), waitingSince: since.get(t.id)?.toISOString() ?? null,
    waitingDays: since.has(t.id) ? Math.max(0, Math.floor((now.getTime() - since.get(t.id)!.getTime()) / 86400000)) : null }));
}

export async function dashboardTasks(user: Actor, now = new Date()) {
  return db.$transaction(async tx => {
    const own = ownOpenScope(user), approval = approvalScope(user);
    const [open, overdue, awaiting, priorities, approvals] = await Promise.all([
      tx.task.count({ where: own }), tx.task.count({ where: { ...own, dueDate: { lt: startOfTodayIST(now) } } }),
      tx.task.count({ where: approval }),
      tx.task.findMany({ where: own, select: taskSelect, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }], take: 4 }),
      tx.task.findMany({ where: approval, select: taskSelect, orderBy: { id: "asc" }, take: 3 }),
    ]);
    return { asOf: now.toISOString(), open, overdue, awaiting, priorities: priorities.map(shape), approvals: await approvalRows(tx, approvals, now, user.id) };
  }, { isolationLevel: "RepeatableRead" });
}

export async function dashboardApprovals(user: Actor, cursor?: string, now = new Date()) {
  return db.$transaction(async tx => {
    const where = approvalScope(user);
    if (cursor && !await tx.task.findFirst({ where: { AND: [where, { id: cursor }] }, select: { id: true } })) throw notFound("Task");
    const [total, rows] = await Promise.all([tx.task.count({ where }), tx.task.findMany({ where, select: taskSelect, orderBy: { id: "asc" }, take: 26,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })]);
    const page = rows.slice(0, 25);
    return { asOf: now.toISOString(), total, items: await approvalRows(tx, page, now, user.id), nextCursor: rows.length > 25 ? page[page.length - 1].id : null };
  }, { isolationLevel: "RepeatableRead" });
}

export async function dashboardProjects(user: Actor, now = new Date()) {
  return db.$transaction(async tx => {
    const where = { ...dashboardProjectScope(user), typeId: WORKSTREAM_PROJECT };
    const [total, projects] = await Promise.all([tx.project.count({ where }), tx.project.findMany({ where, select: { id: true, name: true, isVertical: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 3 })]);
    const counts = projects.length ? await tx.$queryRaw<{ projectId: string; total: bigint; completed: bigint }[]>(Prisma.sql`
      SELECT "projectId", count(*) AS total, count(*) FILTER (WHERE "completedAt" IS NOT NULL) AS completed
      FROM "Task" WHERE "projectId" IN (${Prisma.join(projects.map(p => p.id))}) AND "deletedAt" IS NULL AND "parentId" IS NULL GROUP BY "projectId"`) : [];
    const byId = new Map(counts.map(c => [c.projectId, c]));
    return { asOf: now.toISOString(), total, items: projects.map(p => { const c = byId.get(p.id); const total = Number(c?.total ?? 0), completed = Number(c?.completed ?? 0); return { ...p, total, completed, percent: completionPercent(completed, total) }; }) };
  }, { isolationLevel: "RepeatableRead" });
}

/** Same effective-role and task-participation restrictions as projectActivity; no N+1 project reads. */
export async function dashboardActivity(user: Actor, now = new Date()) {
  return db.$transaction(async tx => {
    const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
    const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id FROM "ActionLog" a JOIN "Project" p ON p.id = a."projectId"
      JOIN "ProjectMember" m ON m."projectId" = p.id AND m."userId" = ${user.id}
      WHERE p."deletedAt" IS NULL AND p."archivedAt" IS NULL AND a."createdAt" >= ${cutoff}
      AND (${crmVisible(user)} OR p."typeId" <> 'wst_deal')
      AND (${isAdmin(user)} OR m.role = 'LEADER' OR EXISTS (
        SELECT 1 FROM "ActionLog" creation WHERE creation."projectId" = p.id AND creation."actorId" = ${user.id} AND creation.action IN ('project.created','deal.created'))
        OR (m.role = 'EDITOR' AND a."targetType" = 'task' AND EXISTS (
          SELECT 1 FROM "Task" t WHERE t.id = a."targetId" AND t."projectId" = p.id AND t."deletedAt" IS NULL
          AND (t."parentId" IS NULL OR EXISTS (SELECT 1 FROM "Task" parent WHERE parent.id = t."parentId" AND parent."deletedAt" IS NULL))
          AND (t."assigneeId" = ${user.id} OR t."approverId" = ${user.id} OR EXISTS (
            SELECT 1 FROM "TaskCollaborator" c WHERE c."taskId" = t.id AND c."userId" = ${user.id})))))
      AND (${commentsEnabled()} OR (a.action NOT LIKE 'comment.%' AND NOT (a.action = 'undo' AND coalesce(a."beforeState"->>'action','') LIKE 'comment.%')))
      ORDER BY a."createdAt" DESC, a.id DESC LIMIT 5`);
    const rows = ids.length ? await tx.actionLog.findMany({ where: { id: { in: ids.map(i => i.id) } }, include: { actor: { select: { name: true } }, project: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : [];
    const namesIds = [...new Set(rows.flatMap(idsIn))];
    const [users, sections, tasks] = namesIds.length ? await Promise.all([
      tx.user.findMany({ where: { id: { in: namesIds } }, select: { id: true, name: true } }),
      tx.section.findMany({ where: { id: { in: namesIds } }, select: { id: true, name: true } }),
      tx.task.findMany({ where: { id: { in: namesIds } }, select: { id: true, title: true } }),
    ]) : [[], [], []];
    const names = new Map<string, string>([...users, ...sections].map(r => [r.id, r.name]));
    for (const task of tasks) names.set(`t:${task.id}`, task.title);
    return { asOf: now.toISOString(), items: rows.map(r => ({ id: r.id, who: r.actor.name, what: sentence(r, names), when: whenText(r.createdAt), ts: r.createdAt.toISOString(), project: r.project!, via: r.channel === "CONCIERGE" ? "concierge" : "screen" })) };
  }, { isolationLevel: "RepeatableRead" });
}
