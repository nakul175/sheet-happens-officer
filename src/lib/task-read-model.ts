import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/lib/access";
import { formatDueDate } from "@/lib/dates";

/** Shared read shape for task pages, project lists and My Tasks. */
export const taskInclude = {
  assignee: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  collaborators: { select: { user: { select: { id: true, name: true } } } },
  subtasks: { where: { deletedAt: null }, select: { id: true, completedAt: true } },
} as const;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

/** A closed task keeps its approver but is no longer awaiting approval. */
export const awaiting = (t: { approverId: string | null; assigneeId: string; completedAt?: Date | null }) =>
  !!t.approverId && t.assigneeId === t.approverId && !t.completedAt;

export function canClose(userId: string, role: Role, t: { approverId: string | null; assigneeId: string }) {
  if (role === "VIEWER") return false;
  if (t.approverId) return userId === t.approverId || role === "LEADER";
  return true;
}

export function present(t: TaskRow, viewer?: { id: string; role: Role }) {
  return {
    id: t.id,
    projectId: t.projectId,
    sectionId: t.sectionId,
    parentId: t.parentId,
    title: t.title,
    description: t.description,
    priority: t.priority,
    dueDate: formatDueDate(t.dueDate),
    blocked: t.blocked,
    blockedReason: t.blockedReason,
    isIdea: t.isIdea,
    completedAt: t.completedAt,
    assignee: t.assignee,
    approver: t.approver,
    collaborators: t.collaborators.map((c) => c.user),
    awaitingApproval: awaiting(t),
    previousAssigneeId: t.previousAssigneeId,
    createdById: t.createdById,
    subtasks: { total: t.subtasks.length, open: t.subtasks.filter((s) => !s.completedAt).length },
    updatedAt: t.updatedAt,
    ...(viewer ? { canClose: canClose(viewer.id, viewer.role, t) } : {}),
  };
}

export const ORDER = [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }] as const;
