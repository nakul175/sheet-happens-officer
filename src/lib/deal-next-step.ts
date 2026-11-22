import type { Prisma } from "@/generated/prisma/client";
import { WORKSTREAM_DEAL } from "@/lib/crm";
import { notify } from "@/lib/notify";

export const WORKING_CATEGORIES = ["NOT_STARTED", "ACTIVE"] as const;

export const isWorking = (category: string | null | undefined) =>
  !!category && (WORKING_CATEGORIES as readonly string[]).includes(category);

/** SHO-US-12.5 AC2: notify the Leader once when a working deal has no dated open task. */
export async function ensureNextStep(tx: Prisma.TransactionClient, projectId: string, actorId: string | null) {
  // project-lookup-ok: Internal transaction invariant for an already-authorized task mutation or scheduled reminder.
  const p = await tx.project.findUnique({ where: { id: projectId }, select: { name: true, typeId: true, archivedAt: true, stage: { select: { category: true } } } });
  if (!p || p.typeId !== WORKSTREAM_DEAL || p.archivedAt || !isWorking(p.stage?.category)) return;
  const open = await tx.task.count({ where: { projectId, deletedAt: null, completedAt: null, parentId: null, dueDate: { not: null } } });
  if (open > 0) return;
  const leader = await tx.projectMember.findFirst({ where: { projectId, role: "LEADER" }, select: { userId: true } });
  if (!leader) return;
  const unread = await tx.notification.count({ where: { recipientId: leader.userId, projectId, type: "DEAL_NEEDS_NEXT_STEP", readAt: null } });
  if (unread) return;
  await notify(tx, [leader.userId], "DEAL_NEEDS_NEXT_STEP", { actorId, projectId, data: { project: p.name }, includeActor: true });
}
