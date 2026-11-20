import type { Tx } from "@/lib/access";

/**
 * Subtasks completed together with these parents (APL-2721). A cascade writes `withParent` on the
 * subtask's completion row. A subtask ticked done on its own has no `withParent` on its latest
 * completion and stays done. With no completion row left, the same `completedAt` as the parent is
 * the cascade. Trashed subtasks are left out.
 */
export async function cascadedSubtaskIds(tx: Tx, projectId: string, parents: { id: string; completedAt: Date | null }[]) {
  const live = parents.filter((p): p is { id: string; completedAt: Date } => !!p.completedAt);
  if (!live.length) return [] as string[];
  const subs = await tx.task.findMany({
    where: { parentId: { in: live.map((p) => p.id) }, deletedAt: null, completedAt: { not: null } },
    select: { id: true, parentId: true, completedAt: true },
  });
  if (!subs.length) return [] as string[];
  const logs = await tx.actionLog.findMany({
    where: { projectId, targetType: "task", action: "task.completed", targetId: { in: subs.map((s) => s.id) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { targetId: true, afterState: true },
  });
  const latest = new Map<string, { withParent?: unknown } | null>();
  for (const log of logs) {
    if (!latest.has(log.targetId)) latest.set(log.targetId, (log.afterState ?? null) as { withParent?: unknown } | null);
  }
  const at = new Map(live.map((p) => [p.id, p.completedAt.getTime()]));
  return subs.filter((s) => {
    if (!s.parentId || !at.has(s.parentId)) return false;
    const after = latest.get(s.id);
    if (after && typeof after.withParent === "string") return after.withParent === s.parentId;
    if (latest.has(s.id)) return false;
    return !!s.completedAt && at.get(s.parentId) === s.completedAt.getTime();
  }).map((s) => s.id);
}
