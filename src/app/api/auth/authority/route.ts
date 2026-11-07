import { createHash } from "node:crypto";
import { currentUser } from "@/lib/auth";
import { crmMode } from "@/lib/access";
import { db } from "@/lib/db";
import { handle } from "@/lib/http";

// A cache invalidation hint, never a permission token. Native handlers still
// evaluate the current database authority on every read and mutation.
export const GET = handle(async () => {
  const user = await currentUser();
  const memberships = await db.projectMember.findMany({
    where: { userId: user.id },
    orderBy: { projectId: "asc" },
    select: { projectId: true, role: true, project: { select: {
      archivedAt: true, deletedAt: true, typeId: true,
      actionLogs: { where: { actorId: user.id, action: { in: ["project.created", "deal.created"] } }, select: { id: true }, take: 1 },
    } } },
  });
  const revision = createHash("sha256").update(JSON.stringify({
    user: user.id, workspace: user.workspaceId, orgRole: user.orgRole,
    crm: crmMode(), memberships,
  })).digest("hex");
  return Response.json({ revision }, { headers: { "Cache-Control": "private, no-store" } });
});
