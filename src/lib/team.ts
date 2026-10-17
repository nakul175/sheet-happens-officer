import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { activeMember, isActive, isAdmin, leaderId, type Actor } from "@/lib/access";
import { auditTx, notify } from "@/lib/notify";
import { releasePerson } from "@/lib/people";

/** SHO-US-2.5. Members see active names only; Admins see everything. */
export async function listTeam(user: Actor) {
  const users = await db.user.findMany({ orderBy: { name: "asc" } });
  if (!isAdmin(user)) {
    return users.filter(isActive).map((u) => ({ id: u.id, name: u.name }));
  }
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    orgRole: u.orgRole,
    status: u.deactivatedAt ? "DEACTIVATED" : !u.emailVerifiedAt ? "UNVERIFIED" : "ACTIVE",
  }));
}

/** SHO-US-2.2. Only the Super Admin; Super Admin itself can never be granted or removed here. */
export async function setOrgRole(actor: Actor, targetId: string, role: "MEMBER" | "ADMIN") {
  if (actor.orgRole !== "SUPER_ADMIN") throw new ApiError(403, "Only the Super Admin can change roles.");
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("Person");
  if (target.orgRole === "SUPER_ADMIN") throw new ApiError(403, "The Super Admin role is set in server configuration only.");
  if (!isActive(target)) throw new ApiError(409, "Only active people can change role.");
  if (target.orgRole === role) return target;
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetId }, data: { orgRole: role } });
    await notify(tx, [targetId], "ORG_ROLE_CHANGED", { actorId: actor.id, data: { role } });
    await auditTx(tx, "ORG_ROLE_CHANGED", { actorId: actor.id, targetId, data: { role } });
  });
  return { ...target, orgRole: role };
}

function mayAct(actor: Actor, target: { orgRole: string }) {
  if (target.orgRole === "SUPER_ADMIN") return false; // protected in the app
  if (target.orgRole === "ADMIN") return actor.orgRole === "SUPER_ADMIN";
  return isAdmin(actor);
}

/** SHO-US-2.3 and 2.4. `reassign` is a person's id, or "leaders" for each project's Leader. */
export async function deactivate(actor: Actor, targetId: string, reassign: string) {
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("Person");
  if (!mayAct(actor, target)) throw new ApiError(403, "You cannot deactivate this person.");
  if (target.id === actor.id) throw new ApiError(409, "You cannot deactivate yourself.");
  if (target.deactivatedAt) throw new ApiError(409, "This person is already deactivated.");

  const memberships = await db.projectMember.findMany({ where: { userId: targetId }, include: { project: true } });
  const leads = memberships.filter((m) => m.role === "LEADER");
  if (leads.length) {
    throw new ApiError(409, "Name a new Leader first for: " + leads.map((m) => m.project.name).join(", "));
  }
  if (reassign !== "leaders") {
    const named = await db.user.findUnique({ where: { id: reassign } });
    if (!named || !isActive(named) || named.id === targetId) throw new ApiError(400, "Choose an active person to take the tasks.");
  }

  return db.$transaction(async (tx) => {
    const fellBack: string[] = [];
    let moved = 0;
    for (const m of memberships) {
      const leader = await leaderId(tx, m.projectId);
      let newAssignee = leader;
      if (reassign !== "leaders") {
        const ok = await activeMember(tx, m.projectId, reassign, ["LEADER", "EDITOR"]);
        if (ok) newAssignee = reassign;
        else fellBack.push(m.project.name);
      }
      const r = await releasePerson(tx, { projectId: m.projectId, userId: targetId, newAssigneeId: newAssignee, actorId: actor.id });
      moved += r.moved;
      if (r.moved && newAssignee !== leader) await notify(tx, [leader], "TASKS_REASSIGNED_SUMMARY", { actorId: actor.id, projectId: m.projectId, data: { count: r.moved, fromUserId: targetId } });
    }
    await tx.user.update({ where: { id: targetId }, data: { deactivatedAt: new Date() } });
    await tx.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
    await auditTx(tx, "USER_DEACTIVATED", { actorId: actor.id, targetId });
    return { moved, fellBack };
  });
}

/** Restores sign-in only; reassigned tasks are not moved back (SHO-US-2.3 AC3). */
export async function reactivate(actor: Actor, targetId: string) {
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("Person");
  if (!mayAct(actor, target)) throw new ApiError(403, "You cannot reactivate this person.");
  if (!target.deactivatedAt) throw new ApiError(409, "This person is not deactivated.");
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetId }, data: { deactivatedAt: null } });
    await auditTx(tx, "USER_REACTIVATED", { actorId: actor.id, targetId });
  });
}
