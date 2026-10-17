import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/access";

type Json = Prisma.InputJsonValue;

/** One bell notice per recipient. The person who caused the event is never told about it. */
export async function notify(
  tx: Tx,
  recipients: (string | null | undefined)[],
  type: string,
  o: { actorId?: string | null; taskId?: string; projectId?: string; data?: Record<string, unknown> },
) {
  const ids = [...new Set(recipients.filter((x): x is string => !!x))].filter((id) => id !== o.actorId);
  if (!ids.length) return;
  await tx.notification.createMany({
    data: ids.map((recipientId) => ({
      recipientId,
      type,
      actorId: o.actorId ?? null,
      taskId: o.taskId,
      projectId: o.projectId,
      data: o.data as Json | undefined,
    })),
  });
}

/** Project action log row with before and after state (feeds Undo in a later slice). */
export async function logAction(
  tx: Tx,
  o: {
    actorId: string;
    projectId: string;
    targetType: "task" | "project" | "section" | "member";
    targetId: string;
    action: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.actionLog.create({
    data: {
      actorId: o.actorId,
      channel: "SCREEN",
      projectId: o.projectId,
      targetType: o.targetType,
      targetId: o.targetId,
      action: o.action,
      beforeState: o.before as Json | undefined,
      afterState: o.after as Json | undefined,
    },
  });
  const event = AUDITED[o.action];
  if (event) {
    await tx.auditLog.create({
      data: { event, actorId: o.actorId, targetType: o.targetType, targetId: o.targetId, channel: "SCREEN", data: { projectId: o.projectId } },
    });
  }
}

// Project actions that are also security-relevant for the organisation audit log (SHO-US-6.5).
const AUDITED: Record<string, string> = {
  "project.created": "PROJECT_CREATED",
  "project.archived": "PROJECT_ARCHIVED",
  "project.unarchived": "PROJECT_UNARCHIVED",
  "project.leader_changed": "PROJECT_LEADER_CHANGED",
  "member.added": "MEMBER_ADDED",
  "member.removed": "MEMBER_REMOVED",
  "member.role_changed": "MEMBER_ROLE_CHANGED",
  "section.deleted": "SECTION_DELETED",
  "task.deleted": "TASK_DELETED",
  "task.restored": "TASK_RESTORED",
  "task.approver_changed": "APPROVER_CHANGED",
};

export async function auditTx(tx: Tx, event: string, o: { actorId?: string | null; targetId?: string; data?: Record<string, unknown> }) {
  await tx.auditLog.create({
    data: { event, actorId: o.actorId ?? null, targetType: o.targetId ? "user" : null, targetId: o.targetId, channel: "SCREEN", data: o.data as Json | undefined },
  });
}
