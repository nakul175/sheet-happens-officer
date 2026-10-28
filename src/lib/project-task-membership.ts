import { db } from "@/lib/db";
import { isActive, projectAccess, requireManage, type Actor, type Tx } from "@/lib/access";
import { ApiError, notFound } from "@/lib/http";
import { logAction, notify } from "@/lib/notify";

/** Explicit task-related membership grant; callers keep this in the same transaction as the task write. */
export async function addWorkspaceTaskMember(tx: Tx, actor: Actor, projectId: string, userId: string) {
  const [project] = await tx.$queryRaw<{ id: string; workspaceId: string; name: string; archivedAt: Date | null }[]>`SELECT "id", "workspaceId", "name", "archivedAt" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  if (!project) throw notFound("Project");
  const personActing = await tx.user.findUnique({ where: { id: actor.id }, select: { workspaceId: true, orgRole: true, deactivatedAt: true, emailVerifiedAt: true } });
  if (!personActing || !isActive(personActing) || personActing.workspaceId !== project.workspaceId) throw notFound("Project");
  const membership = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: actor.id } } });
  if (personActing.orgRole === "MEMBER" && membership?.role !== "LEADER") throw new ApiError(403, "Only the project Leader or an Admin can add people to this project.");
  if (project.archivedAt) throw new ApiError(409, "This project is archived and read-only.");
  const person = await tx.user.findFirst({ where: { id: userId, workspaceId: project.workspaceId, deactivatedAt: null, emailVerifiedAt: { not: null } }, select: { id: true } });
  if (!person) throw new ApiError(400, "Choose an active person from this workspace.");
  // Concurrent requests can both select a non-member. Conflict-safe creation never changes an existing role.
  const added = await tx.projectMember.createMany({ data: [{ projectId, userId, role: "EDITOR" }], skipDuplicates: true });
  if (added.count) {
    await notify(tx, [userId], "ADDED_TO_PROJECT", { actorId: actor.id, projectId, data: { project: project.name, role: "EDITOR" } });
    await logAction(tx, { actorId: actor.id, projectId, targetType: "member", targetId: userId, action: "member.added", after: { role: "EDITOR" }, primary: false });
  }
}

/** Only a project's managers can search active workspace people for an explicit task-related grant. */
export async function workspaceTaskPeople(actor: Actor, projectId: string, query: string, purpose: "assignee" | "collaborator") {
  const access = await projectAccess(actor, projectId, { write: true });
  requireManage(access);
  const me = await db.user.findUnique({ where: { id: actor.id }, select: { workspaceId: true, deactivatedAt: true, emailVerifiedAt: true } });
  if (!me || !isActive(me) || me.workspaceId !== access.project.workspaceId) throw notFound("Project");
  const q = query.trim();
  if (q.length < 2) return [];
  const people = await db.user.findMany({
    where: { workspaceId: access.project.workspaceId, deactivatedAt: null, emailVerifiedAt: { not: null }, name: { contains: q, mode: "insensitive" },
      ...(purpose === "assignee" ? { NOT: { memberships: { some: { projectId, role: "VIEWER" } } } } : {}) },
    select: { id: true, name: true, memberships: { where: { projectId }, select: { role: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }], take: 20,
  });
  return people.map(person => ({ id: person.id, name: person.name, isMember: person.memberships.length > 0 }));
}
