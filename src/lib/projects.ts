import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import {
  activeMember, isActive, isAdmin, projectAccess, requireManage, type Access, type Actor, type Role,
} from "@/lib/access";
import { logAction, notify } from "@/lib/notify";
import { openTaskCount, releasePerson, resolveHandover, type Handover, type Released } from "@/lib/people";
import { WORKSTREAM_DEAL, WORKSTREAM_PROJECT } from "@/lib/crm";
import { dealBlock } from "@/lib/deals";

const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];

/** SHO-US-3.1. The Leader is required and must be active; a creator who names someone else becomes an Editor. */
export async function createProject(user: Actor, input: { name: string; description?: string | null; leaderId: string; members?: { userId: string; role: "EDITOR" | "VIEWER" }[] }) {
  const leader = await db.user.findUnique({ where: { id: input.leaderId } });
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!leader || !isActive(leader) || leader.workspaceId !== me.workspaceId) throw new ApiError(400, "Choose an active person as Leader.");
  // SHO-US-14.17: the people added with the project must be active; the Leader and the creator already have a seat.
  const wanted = new Map<string, "EDITOR" | "VIEWER">();
  for (const m of input.members ?? []) if (m.userId !== leader.id && m.userId !== user.id) wanted.set(m.userId, m.role);
  if (wanted.size) {
    const found = await db.user.findMany({ where: { id: { in: [...wanted.keys()] } } });
    if (found.length !== wanted.size || !found.every(person => isActive(person) && person.workspaceId === me.workspaceId)) throw new ApiError(400, "Choose active people to add.");
  }
  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { workspaceId: me.workspaceId, name: input.name, description: input.description ?? null },
    });
    await tx.projectMember.create({ data: { projectId: project.id, userId: leader.id, role: "LEADER" } });
    if (leader.id !== user.id) await tx.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "EDITOR" } });
    for (const [i, name] of DEFAULT_SECTIONS.entries()) {
      await tx.section.create({ data: { projectId: project.id, name, position: i, isDone: i === DEFAULT_SECTIONS.length - 1 } });
    }
    for (const [userId, role] of wanted) {
      await tx.projectMember.create({ data: { projectId: project.id, userId, role } });
      await notify(tx, [userId], "ADDED_TO_PROJECT", { actorId: user.id, projectId: project.id, data: { project: project.name, role } });
      await logAction(tx, { actorId: user.id, projectId: project.id, targetType: "member", targetId: userId, action: "member.added", after: { role }, primary: false });
    }
    await notify(tx, [leader.id], "MADE_LEADER", { actorId: user.id, projectId: project.id, data: { project: project.name } });
    await logAction(tx, { actorId: user.id, projectId: project.id, targetType: "project", targetId: project.id, action: "project.created", after: { name: project.name, leaderId: leader.id } });
    return project;
  });
}

/** SHO-US-3.2. Members see their own projects; Admins see all. Archived ones only when asked for. */
export async function listProjects(user: Actor, archived: boolean) {
  // project-lookup-ok: Project-only list deliberately supports archived projects; where enforces Admin-or-member access.
  const projects = await db.project.findMany({
    where: {
      // SHO-US-10.4: deals have their own place; this list is for type Project only.
      typeId: WORKSTREAM_PROJECT,
      archivedAt: archived ? { not: null } : null,
      ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }),
    },
    orderBy: { createdAt: "asc" },
    include: {
      members: { where: { role: "LEADER" }, include: { user: { select: { id: true, name: true } } } },
      _count: { select: { tasks: { where: { deletedAt: null, completedAt: null, parentId: null } } } },
    },
  });
  const mine = await db.projectMember.findMany({ where: { userId: user.id } });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    archived: !!p.archivedAt,
    leader: p.members[0]?.user ?? null,
    openTasks: p._count.tasks,
    role: isAdmin(user) ? "LEADER" : mine.find((m) => m.projectId === p.id)?.role ?? null,
    // The person's own seat, if any (Admins see every project but only some are theirs).
    myRole: mine.find((m) => m.projectId === p.id)?.role ?? null,
  }));
}

export async function getProject(user: Actor, projectId: string) {
  const a = await projectAccess(user, projectId);
  const [sections, members, open] = await Promise.all([
    db.section.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    db.projectMember.findMany({ where: { projectId }, include: { user: true }, orderBy: { createdAt: "asc" } }),
    db.task.count({ where: { projectId, deletedAt: null, completedAt: null } }),
  ]);
  const manage = a.role === "LEADER";
  const isDeal = a.project.typeId === WORKSTREAM_DEAL; // a hidden deal was already "not found" in projectAccess (CRM_VISIBLE)
  const deal = isDeal ? await dealBlock(projectId) : null;
  return {
    type: isDeal ? "DEAL" : "PROJECT",
    deal,
    id: a.project.id,
    name: a.project.name,
    description: a.project.description,
    archived: !!a.project.archivedAt,
    role: a.role,
    openTasks: open,
    sections: sections.map((s) => ({ id: s.id, name: s.name, position: s.position, isDone: s.isDone })),
    members: members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      role: m.role,
      active: isActive(m.user),
      ...(manage ? { email: m.user.email } : {}),
    })),
  };
}

export async function updateProject(user: Actor, projectId: string, input: { name?: string; description?: string | null }) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  await db.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: input });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.updated", before: { name: a.project.name, description: a.project.description }, after: input });
  });
}

/** SHO-US-3.6. Notifies each assignee of open tasks. */
export async function archiveProject(user: Actor, projectId: string) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  return db.$transaction(async (tx) => {
    const open = await tx.task.findMany({ where: { projectId, deletedAt: null, completedAt: null }, select: { assigneeId: true } });
    await tx.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await notify(tx, open.map((t) => t.assigneeId), "PROJECT_ARCHIVED", { actorId: user.id, projectId, data: { project: a.project.name } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.archived", before: { archivedAt: null }, after: { archivedAt: new Date().toISOString(), openTasks: open.length } });
    return { openTasks: open.length };
  });
}

export async function unarchiveProject(user: Actor, projectId: string) {
  const a = await projectAccess(user, projectId);
  requireManage(a);
  if (!a.project.archivedAt) throw new ApiError(409, "This project is not archived.");
  await db.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.unarchived", before: { archivedAt: a.project.archivedAt!.toISOString() }, after: { archivedAt: null } });
  });
}

/** SHO-US-3.4 AC1. Role defaults to Editor; "Leader" is only reachable through Change Leader. */
export async function addMember(user: Actor, projectId: string, userId: string, role: "EDITOR" | "VIEWER") {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const person = await db.user.findUnique({ where: { id: userId } });
  if (!person || !isActive(person) || person.workspaceId !== a.project.workspaceId) throw new ApiError(400, "Choose an active person.");
  if (a.project.members.some((m) => m.userId === userId)) throw new ApiError(409, "This person is already a member.");
  await db.$transaction(async (tx) => {
    await tx.projectMember.create({ data: { projectId, userId, role } });
    await notify(tx, [userId], "ADDED_TO_PROJECT", { actorId: user.id, projectId, data: { project: a.project.name, role } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "member", targetId: userId, action: "member.added", after: { role } });
  });
}

/**
 * A single taker for the person's open tasks, or null when there are none. The concierge card names a taker per
 * task instead (SHO-BUG-7); then no single taker is needed, and a task that appears in between goes to the Leader.
 */
async function requireHandoverIfNeeded(a: Access, userId: string, handoverTo: string | undefined | null, handover?: Handover[]) {
  const open = await openTaskCount(db, a.project.id, userId);
  if (!open) return null;
  const target = await resolveHandover(db, a.project.id, userId, handoverTo);
  if (target) return target;
  if (handover?.length) {
    const held = await db.task.findMany({ where: { projectId: a.project.id, assigneeId: userId, completedAt: null, deletedAt: null }, select: { id: true } });
    if (held.every((t) => handover.some((h) => h.taskId === t.id && h.assigneeId))) return null;
  }
  throw new ApiError(409, `Choose a Leader or Editor to take ${open} open task${open === 1 ? "" : "s"} first.`);
}

/** SHO-US-3.4 AC3/AC4/AC5 and SHO-US-3.3 AC5. */
export async function changeMemberRole(user: Actor, projectId: string, userId: string, role: "EDITOR" | "VIEWER", handoverTo?: string | null, handover?: Handover[]) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const m = a.project.members.find((x) => x.userId === userId);
  if (!m) throw notFound("Member");
  if (m.role === "LEADER") throw new ApiError(409, "Use Change Leader to replace the project's Leader.");
  if (m.role === role) return;
  const target = role === "VIEWER" ? await requireHandoverIfNeeded(a, userId, handoverTo, handover) : null;
  await db.$transaction(async (tx) => {
    let rel: Released | null = null;
    if (role === "VIEWER") {
      const leader = a.project.members.find((x) => x.role === "LEADER")!.userId;
      rel = await releasePerson(tx, { projectId, userId, newAssigneeId: target ?? leader, actorId: user.id, keepCollaborations: true, handover });
    }
    await tx.projectMember.update({ where: { projectId_userId: { projectId, userId } }, data: { role } });
    await notify(tx, [userId], "PROJECT_ROLE_CHANGED", { actorId: user.id, projectId, data: { project: a.project.name, role, ...(rel?.note ?? {}) } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "member", targetId: userId, action: "member.role_changed", before: { role: m.role }, after: { role, handedOver: rel?.moved ?? 0 } });
  });
}

/** SHO-US-3.4 AC3. Removal that cannot be undone once tasks have been handed over (decided in SHO-US-8.3). */
export async function removeMember(user: Actor, projectId: string, userId: string, handoverTo?: string | null, handover?: Handover[]) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const m = a.project.members.find((x) => x.userId === userId);
  if (!m) throw notFound("Member");
  if (m.role === "LEADER") throw new ApiError(409, "Use Change Leader to replace the project's Leader.");
  const target = await requireHandoverIfNeeded(a, userId, handoverTo, handover);
  await db.$transaction(async (tx) => {
    const leader = a.project.members.find((x) => x.role === "LEADER")!.userId;
    const rel = await releasePerson(tx, { projectId, userId, newAssigneeId: target ?? leader, actorId: user.id, handover });
    await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
    await notify(tx, [userId], "REMOVED_FROM_PROJECT", { actorId: user.id, projectId, data: { project: a.project.name, ...rel.note } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "member", targetId: userId, action: "member.removed", before: { role: m.role }, after: { removed: true, handedOver: rel.moved } });
  });
}

/** SHO-US-3.5. One step, exactly one Leader before and after. */
export async function changeLeader(
  user: Actor,
  projectId: string,
  input: { newLeaderId: string; previousRole: "EDITOR" | "VIEWER" | "REMOVE"; handoverTo?: string | null },
) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const old = a.project.members.find((m) => m.role === "LEADER")!;
  if (input.newLeaderId === old.userId) throw new ApiError(400, "That person is already the Leader.");
  const next = await activeMember(db, projectId, input.newLeaderId);
  if (!next) throw new ApiError(400, "Choose an active member of this project.");

  let target: string | null = null;
  if (input.previousRole !== "EDITOR") {
    const open = await openTaskCount(db, projectId, old.userId);
    if (open) {
      // The new Leader counts as a valid taker, so the default is simply the new Leader.
      target = input.handoverTo === input.newLeaderId ? input.newLeaderId : (await resolveHandover(db, projectId, old.userId, input.handoverTo));
      if (!target) throw new ApiError(409, `Choose a Leader or Editor to take ${open} open task${open === 1 ? "" : "s"} first.`);
    }
  }
  await db.$transaction(async (tx) => {
    // Demote first so the one-Leader index is never violated, then promote.
    await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: old.userId } }, data: { role: "EDITOR" } });
    await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: input.newLeaderId } }, data: { role: "LEADER" } });
    let rel: Released | null = null;
    if (input.previousRole === "VIEWER") {
      rel = await releasePerson(tx, { projectId, userId: old.userId, newAssigneeId: target ?? input.newLeaderId, actorId: user.id, keepCollaborations: true });
      await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: old.userId } }, data: { role: "VIEWER" } });
    } else if (input.previousRole === "REMOVE") {
      rel = await releasePerson(tx, { projectId, userId: old.userId, newAssigneeId: target ?? input.newLeaderId, actorId: user.id });
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId: old.userId } } });
    }
    await notify(tx, [input.newLeaderId], "MADE_LEADER", { actorId: user.id, projectId, data: { project: a.project.name } });
    await notify(tx, [old.userId], input.previousRole === "REMOVE" ? "REMOVED_FROM_PROJECT" : "PROJECT_ROLE_CHANGED", {
      actorId: user.id, projectId, data: { project: a.project.name, role: input.previousRole, ...(rel?.note ?? {}) },
    });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.leader_changed", before: { leaderId: old.userId }, after: { leaderId: input.newLeaderId, previousRole: input.previousRole, handedOver: rel?.moved ?? 0 } });
  });
}

export type { Role };
