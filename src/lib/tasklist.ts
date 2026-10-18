// SHO-US-14.9: filter and sort the tasks of one project on the server, so a 500-task project answers fast and the same URL
// gives the same list. Grouping by person or week is only a layout and happens in the browser.
import { db } from "@/lib/db";
import { projectAccess, type Actor } from "@/lib/access";
import { startOfTodayIST } from "@/lib/dates";
import { attachCommentCounts } from "@/lib/comments";
import { ORDER, awaiting, present, taskInclude } from "@/lib/tasks";

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export const FLAGS = ["overdue", "blocked", "awaiting", "nodate"] as const;
type Flag = (typeof FLAGS)[number];
type Priority = (typeof PRIORITIES)[number];
export type ListFilter = { assignees: string[]; flags: Flag[]; priorities: Priority[]; sort: "date" | "priority" };

const csv = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** Reads ?assignee=a,b&f=overdue,blocked&priority=HIGH&sort=priority. Returns null when nothing narrows or reorders the list. */
export function parseListFilter(q: URLSearchParams): ListFilter | null {
  const assignees = csv(q.get("assignee")).slice(0, 20);
  const flags = csv(q.get("f")).filter((x): x is Flag => (FLAGS as readonly string[]).includes(x));
  const priorities = csv(q.get("priority")).filter((x): x is Priority => (PRIORITIES as readonly string[]).includes(x));
  const sort = q.get("sort") === "priority" ? "priority" : "date";
  const grouped = q.get("group") === "assignee" || q.get("group") === "week"; // grouping needs every task, not one page per section
  if (!assignees.length && !flags.length && !priorities.length && sort === "date" && !grouped) return null;
  return { assignees, flags: [...new Set(flags)], priorities: [...new Set(priorities)], sort };
}

const CAP = 500;

export async function listFiltered(user: Actor, projectId: string, f: ListFilter) {
  const a = await projectAccess(user, projectId);
  const viewer = { id: user.id, role: a.role };
  const today = startOfTodayIST();
  const sections = await db.section.findMany({ where: { projectId }, orderBy: { position: "asc" } });
  const openOnly = f.flags.some((x) => x === "overdue" || x === "awaiting");
  const rows = await db.task.findMany({
    where: {
      projectId, parentId: null, deletedAt: null,
      ...(openOnly ? { completedAt: null } : {}),
      ...(f.assignees.length ? { assigneeId: { in: f.assignees } } : {}),
      ...(f.priorities.length ? { priority: { in: f.priorities } } : {}),
      ...(f.flags.includes("blocked") ? { blocked: true } : {}),
      ...(f.flags.includes("nodate") ? { dueDate: null } : {}),
      ...(f.flags.includes("overdue") ? { dueDate: { lt: today } } : {}),
      ...(f.flags.includes("awaiting") ? { approverId: { not: null } } : {}),
    },
    include: taskInclude,
    orderBy: f.sort === "priority"
      ? [{ priority: "desc" }, { dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }]
      : [...ORDER],
    take: CAP + 1,
  });
  const kept = (f.flags.includes("awaiting") ? rows.filter(awaiting) : rows).slice(0, CAP);
  const out = [];
  for (const s of sections) {
    const mine = kept.filter((t) => t.sectionId === s.id);
    if (s.isDone) mine.sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0));
    out.push({ id: s.id, name: s.name, isDone: s.isDone, total: mine.length, tasks: await attachCommentCounts(mine.map((t) => present(t, viewer))), nextCursor: null });
  }
  return { sections: out, filtered: true, truncated: rows.length > CAP, matched: kept.length };
}

/** Counts for the heading ("3 overdue"): open top-level tasks of the project. */
export async function projectSummary(user: Actor, projectId: string) {
  await projectAccess(user, projectId);
  const today = startOfTodayIST();
  const open = await db.task.findMany({
    where: { projectId, parentId: null, deletedAt: null, completedAt: null },
    select: { dueDate: true, blocked: true, approverId: true, assigneeId: true },
  });
  return {
    open: open.length,
    overdue: open.filter((t) => t.dueDate && t.dueDate < today).length,
    blocked: open.filter((t) => t.blocked).length,
    awaiting: open.filter((t) => t.approverId && t.approverId === t.assigneeId).length,
  };
}
