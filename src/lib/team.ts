import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { activeMember, isActive, isAdmin, leaderId, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmProjectWhere, crmVisible } from "@/lib/crm";
import { auditTx, notify } from "@/lib/notify";
import { generatePassword, hashPassword, superAdminEmails } from "@/lib/auth";
import { sendMail, signInDetailsMail } from "@/lib/email";
import { releasePerson } from "@/lib/people";

/**
 * SHO-US-2.5 and SHO-US-14.4. Everyone sees each active person's organisation role and the projects they lead.
 * Led projects are only those the viewer can see: their own projects (Admins: all live projects).
 * Members see active names only; Admins see everything.
 */
export async function listTeam(user: Actor) {
  const users = await db.user.findMany({ orderBy: { name: "asc" } });
  const led = await db.projectMember.findMany({
    where: { role: "LEADER", project: { archivedAt: null, typeId: "wst_project", ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }) } },
    select: { userId: true, project: { select: { id: true, name: true } } },
    orderBy: { project: { name: "asc" } },
  });
  const leads = (id: string) => led.filter((l) => l.userId === id).map((l) => l.project);
  if (!isAdmin(user)) {
    return users.filter(isActive).map((u) => ({ id: u.id, name: u.name, orgRole: u.orgRole, leads: leads(u.id) }));
  }
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    orgRole: u.orgRole,
    status: u.deactivatedAt ? "DEACTIVATED" : !u.emailVerifiedAt ? "UNVERIFIED" : "ACTIVE",
    leads: leads(u.id),
  }));
}

/** SHO-US-2.1 AC3: a listed address is protected whatever its stored role says. */
const isSuper = (u: { orgRole: string; email: string }) => u.orgRole === "SUPER_ADMIN" || superAdminEmails().includes(u.email.toLowerCase());

/** SHO-US-2.2. Only the Super Admin; Super Admin itself can never be granted or removed here. */
export async function setOrgRole(actor: Actor, targetId: string, role: "MEMBER" | "ADMIN") {
  if (actor.orgRole !== "SUPER_ADMIN") throw new ApiError(403, "Only the Super Admin can change roles.");
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("Person");
  if (isSuper(target)) throw new ApiError(403, "The Super Admin role is set in server configuration only.");
  if (!isActive(target)) throw new ApiError(409, "Only active people can change role.");
  if (target.orgRole === role) return target;
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetId }, data: { orgRole: role } });
    await notify(tx, [targetId], "ORG_ROLE_CHANGED", { actorId: actor.id, data: { role } });
    await auditTx(tx, role === "ADMIN" ? "ADMIN_PROMOTED" : "ADMIN_DEMOTED", { actorId: actor.id, targetId, data: { role } });
  });
  return { ...target, orgRole: role };
}

function mayAct(actor: Actor, target: { orgRole: string; email: string }) {
  if (isSuper(target)) return false; // protected in the app
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
    // A caller who can see the CRM gets every leadership, in the same order as before (APL-2735 AC2).
    // crmProjectWhere drops deals the caller cannot see, so those names, ids and counts stay out of the 409.
    let visible = leads;
    if (!crmVisible(actor)) {
      const visibleIds = new Set((await db.projectMember.findMany({
        where: { userId: targetId, role: "LEADER", project: crmProjectWhere(actor) },
        select: { projectId: true },
      })).map((row) => row.projectId));
      visible = leads.filter((m) => visibleIds.has(m.projectId));
    }
    if (!visible.length) throw new ApiError(409, "Name a new Leader first.");
    throw new ApiError(409, "Name a new Leader first for: " + visible.map((m) => m.project.name).join(", "), {
      leads: visible.map((m) => ({ id: m.projectId, name: m.project.name })),
    });
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

type AddInput = { firstName: string; lastName: string; email: string; role: "MEMBER" | "ADMIN" };

/** SHO-US-15.2. Super Admin only. The account is active at once; the password goes out by email and is never stored in clear. */
export async function addPerson(actor: Actor & { name?: string }, input: AddInput) {
  if (actor.orgRole !== "SUPER_ADMIN") throw new ApiError(403, "Only the Super Admin can add people.");
  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ApiError(409, existing.deactivatedAt ? "This person already has an account and is deactivated. Reactivate them from the Team list." : "A person with this email already exists.", {
      existingId: existing.id,
    });
  }
  const workspace =
    (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await db.workspace.create({ data: { name: "Workspace" } }));
  const password = generatePassword();
  const now = new Date();
  const user = await db.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        workspaceId: workspace.id,
        email: input.email,
        name: `${input.firstName} ${input.lastName}`,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: now,
        tempPasswordAt: now,
        // A listed Super Admin address stays Super Admin whatever role was picked (SHO-US-2.1 AC3).
        orgRole: superAdminEmails().includes(input.email) ? "SUPER_ADMIN" : input.role,
      },
    });
    await auditTx(tx, "USER_ADDED_BY_ADMIN", { actorId: actor.id, targetId: u.id, data: { role: u.orgRole } });
    return u;
  });
  const emailSent = await sendDetails(user.email, input.firstName, actor.name ?? "A Super Admin", password);
  return { id: user.id, name: user.name, email: user.email, orgRole: user.orgRole, emailSent };
}

async function sendDetails(to: string, firstName: string, by: string, password: string) {
  try {
    await sendMail(signInDetailsMail(to, firstName, by, password));
    return true;
  } catch {
    return false; // the account exists; the Super Admin is told and can resend
  }
}

/** SHO-US-15.3. New password, old one dead, every session signed out. The Super Admin never sees it. */
export async function resendSignIn(actor: Actor & { name?: string }, targetId: string) {
  if (actor.orgRole !== "SUPER_ADMIN") throw new ApiError(403, "Only the Super Admin can resend sign-in details.");
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("Person");
  if (target.id === actor.id) throw new ApiError(409, "Use Profile to change your own password.");
  if (target.deactivatedAt) throw new ApiError(409, "Reactivate this person first.");
  const password = generatePassword();
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetId }, data: { passwordHash: await hashPassword(password), tempPasswordAt: now, emailVerifiedAt: target.emailVerifiedAt ?? now } });
    await tx.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: now } });
    await tx.loginAttempt.deleteMany({ where: { email: target.email } });
    await auditTx(tx, "USER_SIGNIN_RESENT", { actorId: actor.id, targetId });
  });
  const emailSent = await sendDetails(target.email, target.name.split(" ")[0], actor.name ?? "A Super Admin", password);
  return { emailSent };
}

/**
 * APL-2716 redaction for a deal this viewer may not see.
 * Generic text only: no deal name, no id, no href. The stored name is not read.
 */
export const HIDDEN_DEAL_LABEL = "A deal you can't view.";

const hiddenDealRows = (count: number) => Array.from({ length: count }, () => ({ name: HIDDEN_DEAL_LABEL, href: null as null }));

/** SHO-US-15.4. Members see a name and shared projects. Admins see the rest. A hidden deal is generic text (APL-2728). */
export async function getPerson(actor: Actor, targetId: string) {
  const target = await db.user.findUnique({ where: { id: targetId } });
  const admin = isAdmin(actor);
  if (!target || (!admin && !isActive(target))) throw notFound("Person");
  const mine = admin ? null : new Set((await db.projectMember.findMany({ where: { userId: actor.id }, select: { projectId: true } })).map((m) => m.projectId));
  // crmProjectWhere drops deals when the CRM is hidden, so those names are never selected.
  const rows = await db.projectMember.findMany({
    where: { userId: targetId, project: { archivedAt: null, ...crmProjectWhere(actor) } },
    include: { project: { select: { id: true, name: true } } },
    orderBy: { project: { name: "asc" } },
  });
  const shown = mine ? rows.filter((m) => mine.has(m.projectId)) : rows;
  const hiddenDeals = crmVisible(actor) ? 0 : await db.projectMember.count({
    where: {
      userId: targetId,
      ...(mine ? { projectId: { in: [...mine] } } : {}),
      project: { archivedAt: null, typeId: WORKSTREAM_DEAL },
    },
  });
  const redacted = hiddenDealRows(hiddenDeals);
  if (!admin) return { id: target.id, name: target.name, projects: [...shown.map((m) => ({ id: m.project.id, name: m.project.name })), ...redacted] };
  const open = await db.task.groupBy({
    by: ["projectId"],
    where: {
      assigneeId: targetId,
      completedAt: null,
      deletedAt: null,
      parentId: null,
      // A hidden deal's tasks must not add to the open-task count.
      ...(crmVisible(actor) ? {} : { project: crmProjectWhere(actor) }),
    },
    _count: { _all: true },
  });
  const byProject = new Map(open.map((o) => [o.projectId, o._count._all]));
  return {
    id: target.id,
    name: target.name,
    email: target.email,
    orgRole: target.orgRole,
    status: target.deactivatedAt ? "DEACTIVATED" : !target.emailVerifiedAt ? "UNVERIFIED" : "ACTIVE",
    joinedAt: target.createdAt.toISOString(),
    openTasks: open.reduce((n, o) => n + o._count._all, 0),
    projects: [...shown.map((m) => ({ id: m.project.id, name: m.project.name, role: m.role, openTasks: byProject.get(m.projectId) ?? 0 })), ...redacted],
  };
}
