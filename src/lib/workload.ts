// SHO-2589. Counts and drill-down share one predicate, including subtasks.
import { db } from "@/lib/db";
import { crmVisible, isAdmin, WORKSTREAM_DEAL, type Actor } from "@/lib/access";
import { notFound } from "@/lib/http";
import { addDays, formatDueDate, startOfTodayIST } from "@/lib/dates";

export const WORKLOAD_FILTERS = ["open", "next7", "overdue", "awaiting", "blocked"] as const;
export type WorkloadFilter = typeof WORKLOAD_FILTERS[number];
export type CountableTask = { assigneeId: string; approverId: string | null; dueDate: Date | null; blocked: boolean };
export function matchesWorkload(t: CountableTask, filter: WorkloadFilter, today = startOfTodayIST()) {
  switch (filter) {
    case "overdue": return !!t.dueDate && t.dueDate < today;
    case "next7": return !!t.dueDate && t.dueDate >= today && t.dueDate < addDays(today, 8);
    case "awaiting": return t.approverId === t.assigneeId;
    case "blocked": return t.blocked;
    default: return true;
  }
}

export async function workloadAvailable(user: Actor) {
  if (isAdmin(user)) return true;
  return !!await db.projectMember.findFirst({ where: { userId: user.id, role: "LEADER", project: { archivedAt: null, deletedAt: null } }, select: { projectId: true } });
}

export async function workload(user: Actor, query = new URLSearchParams()) {
  // Never accept project ids or a workspace from the caller.
  const actor = await db.user.findUnique({ where: { id: user.id }, select: { workspaceId: true, deactivatedAt: true, emailVerifiedAt: true } });
  if (!actor || actor.deactivatedAt || !actor.emailVerifiedAt) throw notFound("Workload");
  // project-lookup-ok: Workload authorizes Admin workspace or led projects only; hidden CRM rows are redacted below.
  const projects = await db.project.findMany({
    where: { workspaceId: actor.workspaceId, archivedAt: null, deletedAt: null, ...(isAdmin(user) ? {} : { members: { some: { userId: user.id, role: "LEADER" } } }) },
    select: { id: true, name: true, typeId: true, members: { select: { userId: true } } },
  });
  if (!isAdmin(user) && !projects.length) throw notFound("Workload");
  const people = await db.user.findMany({
    where: { workspaceId: actor.workspaceId, deactivatedAt: null, emailVerifiedAt: { not: null }, ...(isAdmin(user) ? {} : { id: { in: [...new Set(projects.flatMap(p => p.members.map(m => m.userId)))] } }) },
    select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const tasks = await db.task.findMany({
    where: { workspaceId: actor.workspaceId, projectId: { in: projects.map(p => p.id) }, deletedAt: null, completedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
    select: { id: true, projectId: true, title: true, assigneeId: true, approverId: true, dueDate: true, blocked: true, updatedAt: true },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  });
  const today = startOfTodayIST();
  const rows = people.map(person => {
    const mine = tasks.filter(t => t.assigneeId === person.id);
    return { ...person, counts: Object.fromEntries(WORKLOAD_FILTERS.map(f => [f, mine.filter(t => matchesWorkload(t, f, today)).length])) as Record<WorkloadFilter, number> };
  }).sort((a, b) => b.counts.overdue - a.counts.overdue || b.counts.open - a.counts.open || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const assignee = query.get("assignee");
  const raw = query.get("f") ?? "open";
  const filter: WorkloadFilter = WORKLOAD_FILTERS.includes(raw as WorkloadFilter) ? raw as WorkloadFilter : "open";
  if (assignee && !people.some(p => p.id === assignee)) throw notFound("Person");
  const byId = new Map(projects.map(p => [p.id, p]));
  const visibleCrm = crmVisible(user);
  const items = assignee ? tasks.filter(t => t.assigneeId === assignee && matchesWorkload(t, filter, today)).map(t => {
    const p = byId.get(t.projectId)!;
    // Workload totals include deal work. A hidden CRM never reveals its ids or task text.
    if (p.typeId === WORKSTREAM_DEAL && !visibleCrm) return { id: null, title: "Task in a deal", dueDate: formatDueDate(t.dueDate), project: { id: null, name: "a deal" } };
    return { id: t.id, title: t.title, dueDate: formatDueDate(t.dueDate), project: { id: p.id, name: p.name } };
  }) : [];
  return { people: rows, items, assignee, filter };
}
