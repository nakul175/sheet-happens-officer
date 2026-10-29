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

async function validateVertical(id: string, workspaceId: string) {
  // project-lookup-ok: classification vocabulary is workspace-scoped; it does not grant board membership.
  const vertical = await db.project.findFirst({ where: { id, workspaceId, typeId: WORKSTREAM_PROJECT, isVertical: true, archivedAt: null, deletedAt: null }, select: { id: true } });
  if (!vertical) throw new ApiError(400, "Choose an active vertical in this workspace.");
}

export const VERTICAL_SUGGESTIONS = ["Growth", "Marketing", "Founder's Office"] as const;
export async function listVerticals(user: Actor) {
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
  // project-lookup-ok: only vocabulary labels in the actor's workspace; board access still uses projectAccess.
  const rows = await db.project.findMany({ where: { workspaceId: me.workspaceId, typeId: WORKSTREAM_PROJECT, isVertical: true, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, archivedAt: true } });
  return rows.map(row => ({ id: row.id, name: row.name, retired: !!row.archivedAt }));
}

export async function classifyProject(user: Actor, projectId: string, isVertical: boolean) {
  if (!isAdmin(user)) throw new ApiError(403, "Only Admins classify vertical boards.");
  const a = await projectAccess(user, projectId, { write: true });
  if (a.project.typeId !== WORKSTREAM_PROJECT) throw new ApiError(400, "Deals cannot become vertical boards.");
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
  if (a.project.workspaceId !== me.workspaceId) throw notFound("Project");
  // project-lookup-ok: count references to the already-authorized workspace board to prevent dangling classifications.
  if (!isVertical && await db.project.count({ where: { verticalId: projectId } })) throw new ApiError(409, "Reclassify linked delivery projects before changing this vertical board.");
  await db.$transaction(async tx => {
    await tx.project.update({ where: { id: projectId }, data: { isVertical, ...(isVertical ? { verticalId: null } : {}) } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.classified", before: { isVertical: a.project.isVertical, verticalId: a.project.verticalId }, after: { isVertical, ...(isVertical ? { verticalId: null } : {}) } });
  });
}

/** SHO-US-3.1. The Leader is required and must be active; a creator who names someone else becomes an Editor. */
export async function createProject(user: Actor, input: { name: string; description?: string | null; leaderId: string; verticalId?: string | null; isVertical?: boolean; members?: { userId: string; role: "EDITOR" | "VIEWER" }[] }) {
  if (input.isVertical && !isAdmin(user)) throw new ApiError(403, "Only Admins manage verticals.");
  const leader = await db.user.findUnique({ where: { id: input.leaderId } });
  if (!leader || !isActive(leader)) throw new ApiError(400, "Choose an active person as Leader.");
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (input.verticalId) await validateVertical(input.verticalId, me.workspaceId);
  if (input.isVertical && input.verticalId) throw new ApiError(400, "A vertical board cannot belong to another vertical.");
  // SHO-US-14.17: the people added with the project must be active; the Leader and the creator already have a seat.
  const wanted = new Map<string, "EDITOR" | "VIEWER">();
  for (const m of input.members ?? []) if (m.userId !== leader.id && m.userId !== user.id) wanted.set(m.userId, m.role);
  if (wanted.size) {
    const found = await db.user.findMany({ where: { id: { in: [...wanted.keys()] } } });
    if (found.length !== wanted.size || !found.every(isActive)) throw new ApiError(400, "Choose active people to add.");
  }
  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { workspaceId: me.workspaceId, name: input.name, description: input.description ?? null, ...(input.isVertical ? { isVertical: true } : {}), ...(input.verticalId ? { verticalId: input.verticalId } : {}) },
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
export async function listProjects(user: Actor, archived: boolean, deleted = false) {
  // project-lookup-ok: explicit member scope below; Trash additionally requires the Leader seat; Admins see all.
  const projects = await db.project.findMany({
    where: {
      // SHO-US-10.4: deals have their own place; this list is for type Project only.
      typeId: WORKSTREAM_PROJECT,
      deletedAt: deleted ? { not: null } : null,
      ...(deleted ? {} : { archivedAt: archived ? { not: null } : null }),
      ...(isAdmin(user) ? {} : deleted
        ? { OR: [
            { members: { some: { userId: user.id, role: "LEADER" as const } } },
            { members: { some: { userId: user.id } }, actionLogs: { some: { action: { in: ["project.created", "deal.created"] }, actorId: user.id } } },
          ] }
        : { members: { some: { userId: user.id } } }),
    },
    orderBy: { createdAt: "asc" },
    include: {
      vertical: { select: { id: true, name: true, archivedAt: true, deletedAt: true } },
      actionLogs: { where: { action: { in: ["project.created", "deal.created"] }, actorId: user.id }, select: { id: true }, take: 1 },
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
    isVertical: p.isVertical,
    vertical: p.vertical ? { id: p.vertical.id, name: p.vertical.name, retired: !!(p.vertical.archivedAt || p.vertical.deletedAt) } : null,
    deletedAt: p.deletedAt?.toISOString() ?? null,
    leader: p.members[0]?.user ?? null,
    openTasks: p._count.tasks,
    role: isAdmin(user) || p.actionLogs?.length ? "LEADER" : mine.find((m) => m.projectId === p.id)?.role ?? null,
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
    isVertical: a.project.isVertical,
    verticalId: a.project.verticalId,
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

export async function updateProject(user: Actor, projectId: string, input: { name?: string; description?: string | null; verticalId?: string | null }) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  if (a.project.isVertical && input.name !== undefined && !isAdmin(user)) throw new ApiError(403, "Only Admins rename verticals.");
  if (input.verticalId !== undefined) {
    if (a.project.isVertical || a.project.typeId !== WORKSTREAM_PROJECT) throw new ApiError(400, "Only delivery projects can have a vertical.");
    if (input.verticalId) await validateVertical(input.verticalId, a.project.workspaceId);
  }
  await db.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: input });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.updated", before: { name: a.project.name, description: a.project.description, verticalId: a.project.verticalId }, after: input });
  });
}

/** SHO-US-3.6. Notifies each assignee of open tasks. */
export async function archiveProject(user: Actor, projectId: string) {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  if (a.project.isVertical && !isAdmin(user)) throw new ApiError(403, "Only Admins retire verticals.");
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
  if (a.project.isVertical && !isAdmin(user)) throw new ApiError(403, "Only Admins reactivate verticals.");
  if (!a.project.archivedAt) throw new ApiError(409, "This project is not archived.");
  await db.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.unarchived", before: { archivedAt: a.project.archivedAt!.toISOString() }, after: { archivedAt: null } });
  });
}

/** Recoverable removal: preserve all linked records and restore the original archive state. */
export async function deleteProject(user: Actor, projectId: string, confirmationName: string) {
  const a = await projectAccess(user, projectId);
  requireManage(a);
  if (a.project.isVertical && !isAdmin(user)) throw new ApiError(403, "Only Admins delete verticals.");
  if (a.project.typeId !== WORKSTREAM_PROJECT && a.project.typeId !== WORKSTREAM_DEAL) throw new ApiError(400, "This work item cannot use Trash.");
  if (confirmationName !== a.project.name) throw new ApiError(400, "Enter the exact project name to confirm deletion.");
  const now = new Date();
  return db.$transaction(async tx => {
    const changed = await tx.project.updateMany({ where: { id: projectId, deletedAt: null, updatedAt: a.project.updatedAt }, data: { deletedAt: now, deletedPreviousArchivedAt: a.project.archivedAt, archivedAt: a.project.archivedAt ?? now } });
    if (changed.count !== 1) throw new ApiError(409, "This item changed; reload before deleting.");
    await notify(tx, a.project.members.map(m => m.userId), "PROJECT_DELETED", { actorId: user.id, projectId, data: { project: a.project.name } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.deleted", before: { archivedAt: a.project.archivedAt?.toISOString() ?? null }, after: { deletedAt: now.toISOString(), recoverable: true } });
    return { deleted: true };
  });
}

export async function restoreProject(user: Actor, projectId: string) {
  const a = await projectAccess(user, projectId, { deleted: true });
  requireManage(a);
  if (a.project.isVertical && !isAdmin(user)) throw new ApiError(403, "Only Admins restore verticals.");
  if (!a.project.deletedAt) throw new ApiError(409, "This project is not in Trash.");
  await db.$transaction(async tx => {
    const changed = await tx.project.updateMany({ where: { id: projectId, deletedAt: a.project.deletedAt }, data: { deletedAt: null, archivedAt: a.project.deletedPreviousArchivedAt, deletedPreviousArchivedAt: null } });
    if (changed.count !== 1) throw new ApiError(409, "Project changed; reload before restoring.");
    await notify(tx, a.project.members.map(m => m.userId), "PROJECT_RESTORED", { actorId: user.id, projectId, data: { project: a.project.name } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "project", targetId: projectId, action: "project.restored", before: { deletedAt: a.project.deletedAt!.toISOString() }, after: { archivedAt: a.project.deletedPreviousArchivedAt?.toISOString() ?? null } });
  });
  return { restored: true };
}

/** SHO-US-3.4 AC1. Role defaults to Editor; "Leader" is only reachable through Change Leader. */
export async function addMember(user: Actor, projectId: string, userId: string, role: "EDITOR" | "VIEWER") {
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  const person = await db.user.findUnique({ where: { id: userId } });
  if (!person || !isActive(person)) throw new ApiError(400, "Choose an active person.");
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

/** SHO-3058: eligible workspace people for an explicit add-during-assignment flow. */
export async function searchWorkspacePeople(user: Actor, projectId: string, text: string) {
  const a = await projectAccess(user, projectId);
  requireManage(a);
  const q = text.trim();
  if (q.length < 2) return { people: [], canAdd: true };
  const actor = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
  const people = await db.user.findMany({
    where: {
      workspaceId: actor.workspaceId,
      deactivatedAt: null,
      emailVerifiedAt: { not: null },
      OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }],
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 20,
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { where: { projectId }, select: { role: true }, take: 1 },
    },
  });
  return {
    canAdd: true,
    people: people.map(({ memberships, ...person }) => ({ ...person, memberRole: memberships[0]?.role ?? null })),
  };
}
