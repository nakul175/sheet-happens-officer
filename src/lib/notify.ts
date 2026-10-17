import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/access";
import { reqCtx } from "@/lib/reqctx";
import { UNDO_LABELS } from "@/lib/undoable";

type Json = Prisma.InputJsonValue;

// Within one transaction a person gets one notice per project and task (SHO-US-7.1 AC4).
const sent = new WeakMap<object, Set<string>>();

/**
 * One bell notice per recipient. The person who caused the event is never told about it,
 * unless `includeActor` is set (a Leader must hear that approvers on their project changed).
 */
export async function notify(
  tx: Tx,
  recipients: (string | null | undefined)[],
  type: string,
  o: { actorId?: string | null; taskId?: string; projectId?: string; data?: Record<string, unknown>; includeActor?: boolean },
) {
  const seen = sent.get(tx) ?? new Set<string>();
  sent.set(tx, seen);
  const ids = [...new Set(recipients.filter((x): x is string => !!x))]
    .filter((id) => o.includeActor || id !== o.actorId)
    .filter((id) => {
      const key = `${id}|${o.projectId ?? ""}|${o.taskId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const ctx = reqCtx.getStore();
  if (ctx) ctx.notified = true;
}

/** Project action log row with before and after state (feeds Undo, SHO-US-6.3, 6.4). */
export async function logAction(
  tx: Tx,
  o: {
    actorId: string;
    /** Null for CRM records that belong to no project (organisations, contacts, notes). */
    projectId: string | null;
    targetType: "task" | "project" | "section" | "member" | "deal" | "organisation" | "contact" | "note";
    targetId: string;
    action: string;
    before?: unknown;
    after?: unknown;
    channel?: "SCREEN" | "CONCIERGE";
    /** False for the secondary rows of a bulk action, so the Undo toast points at the main one. */
    primary?: boolean;
  },
) {
  const row = await tx.actionLog.create({
    data: {
      actorId: o.actorId,
      channel: o.channel ?? "SCREEN",
      projectId: o.projectId ?? null,
      targetType: o.targetType,
      targetId: o.targetId,
      action: o.action,
      beforeState: o.before as Json | undefined,
      afterState: o.after as Json | undefined,
    },
  });
  const ctx = reqCtx.getStore();
  if (ctx && o.primary !== false && UNDO_LABELS[o.action]) {
    ctx.undoId = row.id;
    ctx.undoLabel = UNDO_LABELS[o.action];
  }
  const event = AUDITED[o.action];
  if (event) {
    await tx.auditLog.create({
      data: { event, actorId: o.actorId, targetType: o.targetType, targetId: o.targetId, channel: o.channel ?? "SCREEN", data: { projectId: o.projectId } },
    });
  }
  return row;
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
  "tasks.approver_reassigned": "APPROVER_CHANGED",
  "organisation.parent_changed": "ORGANISATION_PARENT_CHANGED",
  "organisation.archived": "ORGANISATION_ARCHIVED",
  "organisation.unarchived": "ORGANISATION_UNARCHIVED",
  "deal.created": "DEAL_CREATED",
  "deal.converted": "DEAL_CONVERTED",
};

export async function auditTx(tx: Tx, event: string, o: { actorId?: string | null; targetId?: string; targetType?: string; data?: Record<string, unknown> }) {
  await tx.auditLog.create({
    data: { event, actorId: o.actorId ?? null, targetType: o.targetId ? o.targetType ?? "user" : null, targetId: o.targetId, channel: "SCREEN", data: o.data as Json | undefined },
  });
}
