import { createHash } from "node:crypto";
import { crmMode } from "@/lib/access";
import { db } from "@/lib/db";
import { workspaceScope, type WorkspaceActor } from "@/lib/workspace-authority";

type RevisionActor = WorkspaceActor & { orgRole: string };

/** Shared server-render and poll fingerprint; it is an invalidation hint, never authority. */
export async function authorityRevision(user: RevisionActor) {
  const memberships = await db.projectMember.findMany({
    where: { userId: user.id, project: workspaceScope(user) },
    orderBy: { projectId: "asc" },
    select: { projectId: true, role: true, project: { select: {
      archivedAt: true, deletedAt: true, typeId: true,
      actionLogs: { where: { actorId: user.id, action: { in: ["project.created", "deal.created"] } }, select: { id: true }, take: 1 },
    } } },
  });
  return createHash("sha256").update(JSON.stringify({
    user: user.id, workspace: user.workspaceId, orgRole: user.orgRole,
    crm: crmMode(), workspaceGeneration: user.workspaceGeneration, memberships,
  })).digest("hex");
}
