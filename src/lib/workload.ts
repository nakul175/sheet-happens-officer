import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { crmProjectWhere, isAdmin, type Actor } from "@/lib/access";
import { addDays, formatDueDate, startOfTodayIST } from "@/lib/dates";
import { notFound } from "@/lib/http";

/** SHO-2589 remains off pending complete drill-down, device and CRM-policy acceptance. */
export function workloadEnabled(env: Record<string, string | undefined> = process.env) {
  return /^(1|true|on|yes)$/i.test((env.FF_WORKLOAD ?? "").trim());
}

export type WorkloadMetric = "open" | "due" | "overdue" | "approval" | "blocked";
export type WorkloadPerson = { id: string; name: string } & Record<WorkloadMetric, number>;

/** The same scope is reused by the summary and its drill-down. Never count hidden CRM rows. */
export function workloadProjectScope(user: Actor, workspaceId: string): Prisma.ProjectWhereInput {
  return {
    workspaceId, archivedAt: null, deletedAt: null, ...crmProjectWhere(user),
    ...(isAdmin(user) ? {} : { members: { some: { userId: user.id, role: "LEADER" } } }),
  };
}

export function workloadTaskScope(projectIds: string[]): Prisma.TaskWhereInput {
  return {
    projectId: { in: projectIds }, deletedAt: null, completedAt: null,
    OR: [{ parentId: null }, { parent: { deletedAt: null } }],
  };
}

/** Due means the seven IST calendar dates starting today; overdue is strictly before today. */
export function workloadMetricScope(metric: Exclude<WorkloadMetric, "approval">, now: Date): Prisma.TaskWhereInput {
  const today = startOfTodayIST(now);
  if (metric === "due") return { dueDate: { gte: today, lt: addDays(today, 7) } };
  if (metric === "overdue") return { dueDate: { lt: today } };
  if (metric === "blocked") return { blocked: true };
  return {};
}

export async function workloadSummary(user: Actor, now = new Date()) {
  if (!workloadEnabled()) throw notFound("Workload");
  return db.$transaction(async tx => {
    const me = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
    const projects = await tx.project.findMany({ where: workloadProjectScope(user, me.workspaceId), select: { id: true } });
    if (!isAdmin(user) && !projects.length) throw notFound("Workload");
    const projectIds = projects.map(p => p.id);
    const people = await tx.user.findMany({
      where: { workspaceId: me.workspaceId, ...(isAdmin(user) ? {} : { memberships: { some: { projectId: { in: projectIds } } } }) },
      select: { id: true, name: true },
    });
    const base = workloadTaskScope(projectIds);
    const grouped = (where: Prisma.TaskWhereInput) => tx.task.groupBy({ by: ["assigneeId"], where: { AND: [base, where] }, _count: { _all: true } });
    const [open, due, overdue, approval, blocked] = await Promise.all([
      grouped({}), grouped(workloadMetricScope("due", now)), grouped(workloadMetricScope("overdue", now)),
      // Match the existing awaiting() rule: the current assignee is also the named approver.
      grouped({ approverId: { equals: tx.task.fields.assigneeId } }), grouped({ blocked: true }),
    ]);
    const index = (rows: typeof open) => new Map(rows.map(r => [r.assigneeId, r._count._all]));
    const metrics = { open: index(open), due: index(due), overdue: index(overdue), approval: index(approval), blocked: index(blocked) };
    const items: WorkloadPerson[] = people.map(p => ({ ...p, open: metrics.open.get(p.id) ?? 0, due: metrics.due.get(p.id) ?? 0, overdue: metrics.overdue.get(p.id) ?? 0, approval: metrics.approval.get(p.id) ?? 0, blocked: metrics.blocked.get(p.id) ?? 0 }));
    items.sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { asOf: now.toISOString(), dueWindow: { from: formatDueDate(now), through: formatDueDate(addDays(now, 6)) }, items };
  }, { isolationLevel: "RepeatableRead" });
}

