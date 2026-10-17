// SHO-US-8.2: what the concierge may read. Every function is scoped to the signed-in person:
// a Member sees their own projects, Admins see all, Trash and archived projects are left out.
// Results are trimmed records; nothing is ever read from memory or from earlier turns.
import { db } from "@/lib/db";
import { isAdmin, projectAccess, type Actor } from "@/lib/access";
import { ApiError } from "@/lib/http";
import { addDays, formatDueDate, startOfTodayIST } from "@/lib/dates";
import { awaiting } from "@/lib/tasks";
import { fullDate, shortDate } from "@/lib/concierge/dates";

export type TaskRec = {
  id: string; title: string; project: string; projectId: string; due: string | null; dueText: string | null;
  assignee: string; priority: string; blocked: boolean; blockedReason?: string | null; done: boolean; completedOn?: string;
  awaitingApproval?: boolean; overdue?: boolean;
};
export type ProjectRec = { id: string; name: string; role: string | null; leader: string | null; openTasks: number };
export type PersonRec = { id: string; name: string; email: string; sharedProjects: string[] };

const select = {
  id: true, title: true, dueDate: true, priority: true, blocked: true, blockedReason: true, completedAt: true, approverId: true, assigneeId: true,
  assignee: { select: { name: true } }, project: { select: { id: true, name: true } },
} as const;
type Row = {
  id: string; title: string; dueDate: Date | null; priority: string; blocked: boolean; blockedReason: string | null; completedAt: Date | null;
  approverId: string | null; assigneeId: string; assignee: { name: string }; project: { id: string; name: string };
};

/** Names and titles go into prompts: no line breaks or control characters, so they cannot fake a new instruction block. */
export const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

export function toTaskRec(t: Row, today = startOfTodayIST()): TaskRec {
  return {
    id: t.id, title: flat(t.title), project: flat(t.project.name), projectId: t.project.id,
    due: formatDueDate(t.dueDate), dueText: t.dueDate ? fullDate(t.dueDate) : null,
    assignee: flat(t.assignee.name), priority: t.priority, blocked: t.blocked,
    ...(t.blocked && t.blockedReason ? { blockedReason: flat(t.blockedReason) } : {}),
    done: !!t.completedAt, ...(t.completedAt ? { completedOn: shortDate(t.completedAt) } : {}),
    ...(awaiting(t) ? { awaitingApproval: true } : {}),
    ...(!t.completedAt && t.dueDate && t.dueDate < today ? { overdue: true } : {}),
  };
}

/** Projects the person may see right now. */
export const visibleProjects = (user: Actor) => ({
  archivedAt: null,
  ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }),
});

const byProjectThenDue = (a: TaskRec, b: TaskRec) =>
  a.project.localeCompare(b.project) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title);

export type MyFilter = "due_week" | "overdue" | "waiting_on_me" | "blocked" | "recently_completed" | "all_open";

/** The person's own open work (assignee or collaborator, in projects they belong to), by filter. */
export async function myTasks(user: Actor, filter: MyFilter, o: { limit?: number; now?: Date } = {}) {
  const today = startOfTodayIST(o.now);
  const limit = o.limit ?? 30;
  const mine = {
    deletedAt: null,
    project: { archivedAt: null, members: { some: { userId: user.id } } },
    OR: [{ assigneeId: user.id }, { collaborators: { some: { userId: user.id } } }],
  };
  let where: Record<string, unknown>;
  switch (filter) {
    case "due_week": where = { ...mine, completedAt: null, dueDate: { gte: today, lt: addDays(today, 8) } }; break; // today and the next 7 days
    case "overdue": where = { ...mine, completedAt: null, dueDate: { lt: today } }; break;
    case "blocked": where = { ...mine, completedAt: null, blocked: true }; break;
    case "waiting_on_me":
      // Awaiting approval and I am the approver (the approver holds it, so assignee = approver = me).
      where = { deletedAt: null, project: { archivedAt: null, members: { some: { userId: user.id } } }, completedAt: null, approverId: user.id, assigneeId: user.id };
      break;
    case "recently_completed": where = { ...mine, completedAt: { gte: addDays(today, -7) } }; break;
    default: where = { ...mine, completedAt: null };
  }
  const rows = await db.task.findMany({
    where, select,
    orderBy: filter === "recently_completed" ? [{ completedAt: "desc" }] : [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: limit + 1,
  });
  const recs = rows.slice(0, limit).map((r) => toTaskRec(r, today));
  if (filter !== "recently_completed") recs.sort(byProjectThenDue);
  return { tasks: recs, truncated: rows.length > limit };
}

/** Tasks whose title contains the text, in projects the person may see. Most relevant first: project, then due date. */
export async function findTasks(user: Actor, text: string, o: { projectId?: string; includeDone?: boolean; limit?: number } = {}) {
  const q = text.trim();
  if (q.length < 2) return { tasks: [] as TaskRec[], truncated: false };
  const limit = o.limit ?? 25;
  const rows = await db.task.findMany({
    where: {
      deletedAt: null, title: { contains: q, mode: "insensitive" },
      ...(o.includeDone ? {} : { completedAt: null }),
      project: { ...visibleProjects(user), ...(o.projectId ? { id: o.projectId } : {}) },
    },
    select, take: limit + 1, orderBy: [{ createdAt: "asc" }],
  });
  const recs = rows.slice(0, limit).map((r) => toTaskRec(r));
  recs.sort(byProjectThenDue);
  return { tasks: recs, truncated: rows.length > limit };
}

export async function listProjects(user: Actor, text?: string): Promise<ProjectRec[]> {
  const rows = await db.project.findMany({
    where: { ...visibleProjects(user), ...(text && text.trim() ? { name: { contains: text.trim(), mode: "insensitive" as const } } : {}) },
    orderBy: { createdAt: "asc" }, take: 50,
    include: {
      members: { include: { user: { select: { name: true } } } },
      _count: { select: { tasks: { where: { deletedAt: null, completedAt: null, parentId: null } } } },
    },
  });
  return rows.map((p) => ({
    id: p.id, name: flat(p.name),
    role: isAdmin(user) ? "LEADER" : p.members.find((m) => m.userId === user.id)?.role ?? null,
    leader: flat(p.members.find((m) => m.role === "LEADER")?.user.name ?? "") || null,
    openTasks: p._count.tasks,
  }));
}

export async function projectTasks(user: Actor, projectId: string, status: "open" | "done" | "all" = "open", limit = 40) {
  const a = await projectAccess(user, projectId); // non-members get "not found"
  if (a.project.archivedAt) return { project: a.project.name, tasks: [] as TaskRec[], truncated: false };
  const rows = await db.task.findMany({
    where: { projectId, deletedAt: null, ...(status === "open" ? { completedAt: null } : status === "done" ? { completedAt: { not: null } } : {}) },
    select, take: limit + 1, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  return { project: a.project.name, tasks: rows.slice(0, limit).map((r) => toTaskRec(r)), truncated: rows.length > limit };
}

/** People who share a project with the person (Admins: everyone on a project they can see). Active people only. */
export async function findPeople(user: Actor, text: string, projectId?: string, limit = 20): Promise<PersonRec[]> {
  const q = text.trim();
  if (q.length < 2) return [];
  if (projectId) await projectAccess(user, projectId);
  const rows = await db.projectMember.findMany({
    where: {
      project: { ...visibleProjects(user), ...(projectId ? { id: projectId } : {}) },
      user: { deactivatedAt: null, emailVerifiedAt: { not: null }, OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
    },
    select: { user: { select: { id: true, name: true, email: true } }, project: { select: { name: true } } },
    take: 200,
  });
  const by = new Map<string, PersonRec>();
  for (const r of rows) {
    const cur = by.get(r.user.id) ?? { id: r.user.id, name: flat(r.user.name), email: flat(r.user.email), sharedProjects: [] };
    if (cur.sharedProjects.length < 5) cur.sharedProjects.push(flat(r.project.name));
    by.set(r.user.id, cur);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

// ------------------------------------------------------------------ quick actions (no model call)
export const QUICK_ACTIONS = [
  { id: "due-week", label: "Due this week", filter: "due_week" as const, empty: "due this week" },
  { id: "overdue", label: "Overdue", filter: "overdue" as const, empty: "overdue" },
  { id: "waiting-on-me", label: "Waiting on me", filter: "waiting_on_me" as const, empty: "waiting for your approval" },
  { id: "blocked", label: "Blocked", filter: "blocked" as const, empty: "blocked" },
  { id: "recently-completed", label: "Recently completed", filter: "recently_completed" as const, empty: "completed in the last 7 days" },
];

export async function quickAnswer(user: Actor, id: string, now = new Date()) {
  const q = QUICK_ACTIONS.find((x) => x.id === id);
  if (!q) throw new ApiError(404, "No such quick action");
  const { tasks, truncated } = await myTasks(user, q.filter, { now });
  if (!tasks.length) return { q, text: "I found nothing.", tasks };
  const lines = tasks.map((t) => `${t.title} (${t.project}${t.dueText ? `, due ${t.dueText}` : ""}${t.completedOn ? `, completed ${t.completedOn}` : ""})`);
  const head = `${q.label}: ${tasks.length}${truncated ? "+" : ""} task${tasks.length === 1 ? "" : "s"}`;
  return { q, text: `${head}\n${lines.map((l) => `- ${l}`).join("\n")}`, tasks };
}

// ------------------------------------------------------------------ single records (for a picked choice)
export async function taskById(user: Actor, id: string) {
  const t = await db.task.findFirst({ where: { id, deletedAt: null, project: visibleProjects(user) }, select });
  return t ? toTaskRec(t) : null;
}
export async function projectById(user: Actor, id: string) {
  return (await listProjects(user)).find((p) => p.id === id) ?? null;
}
export async function personById(user: Actor, id: string): Promise<PersonRec | null> {
  const m = await db.projectMember.findMany({
    where: { userId: id, project: visibleProjects(user), user: { deactivatedAt: null, emailVerifiedAt: { not: null } } },
    select: { user: { select: { id: true, name: true, email: true } }, project: { select: { name: true } } }, take: 5,
  });
  return m.length ? { id: m[0].user.id, name: flat(m[0].user.name), email: flat(m[0].user.email), sharedProjects: m.map((x) => flat(x.project.name)) } : null;
}
