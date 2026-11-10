import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { WORKSTREAM_DEAL, crmProjectWhere, crmVisible } from "@/lib/crm";
import { addDays, formatDueDate, startOfTodayIST } from "@/lib/dates";
import { type Actor, type Role, type Tx } from "@/lib/access";
import { canClose } from "@/lib/tasks";
import { ApiError } from "@/lib/http";

const GROUPS = ["waitingOnMe", "overdue", "next7", "later", "waitingOnOthers", "needsNextStep"] as const;
export type MyTasksGroup = (typeof GROUPS)[number];
const TASK_GROUPS = GROUPS.slice(0, 5) as readonly Exclude<MyTasksGroup, "needsNextStep">[];
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;
const cursorKey = randomBytes(32); // Restart invalidates a cursor; the client offers Refresh.

type Cursor = { group: MyTasksGroup; userId: string; id: string; filter?: "overdue"; dueDate?: string | null; createdAt?: string };
const invalidCursor = () => new ApiError(400, "This page expired. Refresh My tasks.");

function sign(payload: string) { return createHmac("sha256", cursorKey).update(payload).digest(); }
function encodeCursor(value: Cursor) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}
function decodeCursor(raw: string | null, group: MyTasksGroup, userId: string, filter?: "overdue"): Cursor | null {
  if (!raw) return null;
  if (raw.length > 1024) throw invalidCursor();
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) throw invalidCursor();
  const received = Buffer.from(signature, "base64url");
  const expected = sign(payload);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw invalidCursor();
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as Cursor;
    if (value.group !== group || value.userId !== userId || value.filter !== filter || typeof value.id !== "string" || !value.id) throw invalidCursor();
    if (group === "waitingOnOthers" && (typeof value.createdAt !== "string" || !(value.dueDate === null || typeof value.dueDate === "string"))) throw invalidCursor();
    return value;
  } catch { throw invalidCursor(); }
}

const select = {
  id: true, title: true, dueDate: true, blocked: true, priority: true, assigneeId: true, approverId: true,
  previousAssigneeId: true, updatedAt: true, createdAt: true, isIdea: true,
  assignee: { select: { id: true, name: true } }, approver: { select: { id: true, name: true } },
  parent: { select: { id: true, title: true } },
  project: { select: { id: true, name: true, typeId: true, stage: { select: { name: true } }, members: { select: { role: true } } } },
} satisfies Prisma.TaskSelect;

type SelectedTask = Prisma.TaskGetPayload<{ select: typeof select }>;
const orderBy = [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }] as const;

function taskWhere(user: Actor, group: Exclude<MyTasksGroup, "needsNextStep">, today: Date, weekEnd: Date, overdueOnly: boolean): Prisma.TaskWhereInput {
  const project = { deletedAt: null, archivedAt: null, members: { some: { userId: user.id } }, ...crmProjectWhere(user) };
  if (group === "waitingOnOthers") {
    return { completedAt: null, deletedAt: null, previousAssigneeId: user.id, approverId: { not: null }, assigneeId: { not: user.id }, project };
  }
  const base: Prisma.TaskWhereInput = {
    completedAt: null, deletedAt: null, project,
    OR: [{ assigneeId: user.id }, { collaborators: { some: { userId: user.id } } }],
    AND: [{ OR: [{ parentId: null }, { parent: { deletedAt: null } }] }],
  };
  const waiting = { approverId: user.id, assigneeId: user.id };
  if (group === "waitingOnMe") return { AND: [base, waiting, ...(overdueOnly ? [{ dueDate: { lt: today } }] : [])] };
  const date: Prisma.TaskWhereInput = group === "overdue" ? { dueDate: { lt: today } }
    : group === "next7" ? { dueDate: { gte: today, lt: weekEnd } }
      : { OR: [{ dueDate: null }, { dueDate: { gte: weekEnd } }] };
  // A plain NOT over nullable approverId drops ordinary tasks under SQL's three-valued logic.
  // Name each non-waiting case so NULL approvers remain visible in their due-date group.
  const notWaiting: Prisma.TaskWhereInput = { OR: [{ approverId: null }, { approverId: { not: user.id } }, { assigneeId: { not: user.id } }] };
  return { AND: [base, notWaiting, date] };
}

async function waitingSince(tx: Tx, ids: string[]) {
  const result = new Map<string, Date>();
  if (!ids.length) return result;
  // Return at most one row per visible task. A busy task can have arbitrarily many
  // historical actions, so fetching all of them would undo the page-size bound.
  const rows = await tx.$queryRaw<{ targetId: string; createdAt: Date }[]>(Prisma.sql`
    SELECT DISTINCT ON ("targetId") "targetId", "createdAt"
    FROM "ActionLog"
    WHERE "targetType" = 'task' AND "targetId" IN (${Prisma.join(ids)})
      AND "action" IN ('task.sent_for_approval', 'task.assigned', 'task.approver_changed')
      AND "undoneAt" IS NULL
      AND jsonb_typeof("afterState"->'assigneeId') = 'string'
      AND "afterState"->>'assigneeId' <> ''
    ORDER BY "targetId", "createdAt" DESC, "id" DESC
  `);
  for (const row of rows) result.set(row.targetId, row.createdAt);
  return result;
}

function shape(user: Actor, task: SelectedTask, since: Map<string, Date>, now: number) {
  const role = (task.project.members[0]?.role ?? "VIEWER") as Role;
  return {
    id: task.id, title: task.title, dueDate: formatDueDate(task.dueDate), blocked: task.blocked,
    priority: task.priority, canClose: canClose(user.id, role, task),
    relation: task.assigneeId === user.id ? "ASSIGNEE" : "COLLABORATOR", updatedAt: task.updatedAt,
    project: { id: task.project.id, name: task.project.name, type: task.project.typeId === WORKSTREAM_DEAL ? "DEAL" : "PROJECT", stage: task.project.stage?.name ?? null },
    parent: task.parent, awaitingApproval: !!task.approverId && task.assigneeId === task.approverId,
    isIdea: task.isIdea, approver: task.approver, assignee: task.assignee,
    waitingDays: Math.max(0, Math.floor((now - (since.get(task.id) ?? task.updatedAt).getTime()) / 86400_000)),
  };
}

async function ordinaryPage(tx: Tx, user: Actor, group: (typeof TASK_GROUPS)[number], limit: number, cursor: Cursor | null, today: Date, weekEnd: Date, now: number, overdueOnly: boolean) {
  const where = taskWhere(user, group, today, weekEnd, overdueOnly);
  const total = await tx.task.count({ where });
  const rows = await tx.task.findMany({ where, select: { ...select, project: { ...select.project, select: { ...select.project.select, members: { select: { role: true }, where: { userId: user.id } } } } }, orderBy: [...orderBy], take: limit + 1,
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}) });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const since = group === "waitingOnMe" ? await waitingSince(tx, page.map(row => row.id)) : new Map<string, Date>();
  const last = page.at(-1);
  return { items: page.map(row => shape(user, row, since, now)), total, hasMore,
    nextCursor: hasMore && last ? encodeCursor({ group, userId: user.id, id: last.id, ...(overdueOnly ? { filter: "overdue" as const } : {}) }) : null };
}

async function othersPage(tx: Tx, user: Actor, limit: number, cursor: Cursor | null, now: number) {
  // Prisma cannot express the field-to-field approval invariant. Keep it in SQL, including the
  // same active-project/member/CRM scope as the legacy read, so counts and pages are exact.
  const crm = crmVisible(user) ? Prisma.empty : Prisma.sql`AND p."typeId" <> ${WORKSTREAM_DEAL}`;
  const after = cursor ? cursor.dueDate === null
    ? Prisma.sql`AND t."dueDate" IS NULL AND (t."createdAt", t."id") > (${new Date(cursor.createdAt!)}, ${cursor.id})`
    : Prisma.sql`AND (t."dueDate" > ${new Date(cursor.dueDate!)} OR t."dueDate" IS NULL OR (t."dueDate" = ${new Date(cursor.dueDate!)} AND (t."createdAt", t."id") > (${new Date(cursor.createdAt!)}, ${cursor.id})))`
    : Prisma.empty;
  const base = Prisma.sql`FROM "Task" t JOIN "Project" p ON p."id" = t."projectId" JOIN "ProjectMember" m ON m."projectId" = p."id" AND m."userId" = ${user.id}
    WHERE t."completedAt" IS NULL AND t."deletedAt" IS NULL AND t."previousAssigneeId" = ${user.id}
      AND t."approverId" IS NOT NULL AND t."assigneeId" = t."approverId" AND t."assigneeId" <> ${user.id}
      AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL ${crm}`;
  const counts = await tx.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS count ${base}`);
  const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT t."id" ${base} ${after} ORDER BY t."dueDate" ASC NULLS LAST, t."createdAt" ASC, t."id" ASC LIMIT ${limit + 1}`);
  const hasMore = ids.length > limit;
  const pageIds = ids.slice(0, limit).map(row => row.id);
  const rows = pageIds.length ? await tx.task.findMany({ where: { id: { in: pageIds } }, select: { ...select, project: { ...select.project, select: { ...select.project.select, members: { select: { role: true }, where: { userId: user.id } } } } } }) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const page = pageIds.map(id => byId.get(id)).filter((row): row is SelectedTask => !!row);
  const since = await waitingSince(tx, pageIds);
  const last = page.at(-1);
  return { items: page.map(row => shape(user, row, since, now)), total: Number(counts[0]?.count ?? BigInt(0)), hasMore,
    nextCursor: hasMore && last ? encodeCursor({ group: "waitingOnOthers", userId: user.id, id: last.id, dueDate: last.dueDate?.toISOString() ?? null, createdAt: last.createdAt.toISOString() }) : null };
}

async function needsStepPage(tx: Tx, user: Actor, limit: number, cursor: Cursor | null) {
  if (!crmVisible(user)) return { items: [], total: 0, hasMore: false, nextCursor: null };
  const where: Prisma.ProjectWhereInput = {
    typeId: WORKSTREAM_DEAL, archivedAt: null, members: { some: { userId: user.id, role: "LEADER" } }, stage: { category: { in: ["NOT_STARTED", "ACTIVE"] } },
    tasks: { none: { deletedAt: null, completedAt: null, parentId: null, dueDate: { not: null } } },
  };
  // project-lookup-ok: The where clause requires the actor's LEADER membership and a working, unarchived deal; CRM visibility was checked above.
  const total = await tx.project.count({ where });
  // project-lookup-ok: The same actor-scoped where clause bounds the visible page; the signed cursor cannot widen it.
  const rows = await tx.project.findMany({ where, orderBy: { id: "asc" }, take: limit + 1,
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    select: { id: true, name: true, stage: { select: { name: true } } } });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(row => ({ id: row.id, name: row.name, stage: row.stage?.name ?? null })), total, hasMore,
    nextCursor: hasMore && last ? encodeCursor({ group: "needsNextStep", userId: user.id, id: last.id }) : null };
}

export async function myTasksPaged(user: Actor, query: URLSearchParams) {
  const groupParam = query.get("group");
  if (groupParam && !GROUPS.includes(groupParam as MyTasksGroup)) throw new ApiError(400, "Unknown My tasks group.");
  const group = groupParam as MyTasksGroup | null;
  const overdueOnly = query.get("filter") === "overdue";
  const limitParam = query.get("limit");
  const limit = limitParam === null ? DEFAULT_PAGE : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ApiError(400, "Invalid page size.");
  if (!group && query.has("cursor")) throw invalidCursor();
  const cursor = group ? decodeCursor(query.get("cursor"), group, user.id, overdueOnly ? "overdue" : undefined) : null;
  const today = startOfTodayIST();
  const weekEnd = addDays(today, 8);
  const now = Date.now();
  return db.$transaction(async tx => {
    if (group) {
      const page = overdueOnly && !["waitingOnMe", "overdue"].includes(group)
        ? { items: [], total: 0, hasMore: false, nextCursor: null }
        : group === "needsNextStep" ? await needsStepPage(tx, user, limit, cursor)
        : group === "waitingOnOthers" ? await othersPage(tx, user, limit, cursor, now)
          : await ordinaryPage(tx, user, group, limit, cursor, today, weekEnd, now, overdueOnly);
      return { version: 2, group, page };
    }
    const groups: Partial<Record<MyTasksGroup, unknown>> = {};
    const empty = { items: [], total: 0, hasMore: false, nextCursor: null };
    for (const key of TASK_GROUPS) groups[key] = overdueOnly && !["waitingOnMe", "overdue"].includes(key) ? empty
      : key === "waitingOnOthers" ? await othersPage(tx, user, limit, null, now)
        : await ordinaryPage(tx, user, key, limit, null, today, weekEnd, now, overdueOnly);
    groups.needsNextStep = overdueOnly ? empty : await needsStepPage(tx, user, limit, null);
    return { version: 2, groups, consistency: "Refresh to include changes made after this request." };
  }, { isolationLevel: "RepeatableRead", timeout: 10000 });
}
