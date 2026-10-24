import { db } from "@/lib/db";
import { isActive, projectAccess, requireManage, type Actor } from "@/lib/access";
import { notFound } from "@/lib/http";

/** Leaders can match a known email without exposing email addresses in the Member directory. */
export async function projectMemberCandidates(actor: Actor, projectId: string, query: string) {
  const access = await projectAccess(actor, projectId, { write: true });
  requireManage(access);
  const me = await db.user.findUnique({ where: { id: actor.id }, select: { workspaceId: true, deactivatedAt: true, emailVerifiedAt: true } });
  if (!me || !isActive(me) || me.workspaceId !== access.project.workspaceId) throw notFound("Project");
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  return db.user.findMany({
    where: {
      workspaceId: access.project.workspaceId, deactivatedAt: null, emailVerifiedAt: { not: null },
      NOT: { memberships: { some: { projectId } } },
      OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }],
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }], take: 8,
  });
}
