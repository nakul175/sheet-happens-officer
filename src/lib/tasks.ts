import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import type { TaskStatus } from "@/generated/prisma/client";

const GAP = 1000;

export const taskInclude = {
  assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
  _count: { select: { subtasks: true } },
} as const;

/** Position that places a new/moved task at the end of its column. */
export async function endPosition(projectId: string, status: TaskStatus, parentId: string | null) {
  const last = await db.task.aggregate({
    where: { projectId, status, parentId },
    _max: { position: true },
  });
  return (last._max.position ?? 0) + GAP;
}

/** Position between two neighbours (either may be omitted for top/bottom of column). */
export async function positionBetween(
  workspaceId: string,
  projectId: string,
  status: TaskStatus,
  parentId: string | null,
  beforeId?: string,
  afterId?: string,
) {
  const [before, after] = await Promise.all([
    beforeId ? db.task.findFirst({ where: { id: beforeId, workspaceId, projectId, status, parentId } }) : null,
    afterId ? db.task.findFirst({ where: { id: afterId, workspaceId, projectId, status, parentId } }) : null,
  ]);
  if (beforeId && !before) throw new ApiError(400, "beforeId is not a task in the target column");
  if (afterId && !after) throw new ApiError(400, "afterId is not a task in the target column");

  if (before && after) return (before.position + after.position) / 2;
  // "before" = the task that will sit above the moved one; "after" = the one that will sit below.
  if (before) return before.position + GAP;
  if (after) return after.position - GAP;
  return endPosition(projectId, status, parentId);
}

export async function assertAssignees(workspaceId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const found = await db.user.count({ where: { id: { in: userIds }, workspaceId } });
  if (found !== new Set(userIds).size) throw new ApiError(400, "One or more assignees do not exist");
}
