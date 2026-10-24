// SHO-US-11.1: organisations with a parent tree. Visible to every signed-in Member (owner decision
// 17 Oct 2026); only the creator and Admins edit or archive. Changes are logged with no project.
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { isAdmin, type Actor } from "@/lib/access";
import { requireCrm } from "@/lib/crm";
import { logAction } from "@/lib/notify";

export type OrgInput = {
  name: string; kind?: string | null; country?: string | null;
  level?: "GROUP" | "LEGAL_ENTITY" | "BUYING_OFFICE" | null; parentId?: string | null; force?: boolean;
};

async function me(user: Actor) {
  return db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, workspaceId: true, orgRole: true } });
}

/** Loads an organisation in the person's workspace, or "not found". */
export async function orgOf(user: Actor, id: string) {
  const u = await me(user);
  const org = await db.organisation.findFirst({ where: { id, workspaceId: u.workspaceId } });
  if (!org) throw notFound("Organisation");
  return org;
}

function canEdit(user: Actor, org: { createdById: string }) {
  return isAdmin(user) || org.createdById === user.id;
}
export function requireOrgEdit(user: Actor, org: { createdById: string }) {
  if (!canEdit(user, org)) throw new ApiError(403, "Only the person who added this organisation, or an Admin, can change it.");
}

/** AC3: a parent may never be the organisation itself or one of its own descendants. */
export async function assertNoCycle(orgId: string | null, parentId: string) {
  let cur: string | null = parentId;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === orgId) throw new ApiError(400, "An organisation cannot sit under itself or under one of its own branches.");
    const row: { parentId: string | null } | null = await db.organisation.findUnique({ where: { id: cur }, select: { parentId: true } });
    cur = row?.parentId ?? null;
  }
}

export async function orgPath(id: string) {
  const path: { id: string; name: string }[] = [];
  let cur: string | null = id;
  for (let i = 0; cur && i < 50; i++) {
    const row: { id: string; name: string; parentId: string | null } | null = await db.organisation.findUnique({ where: { id: cur }, select: { id: true, name: true, parentId: true } });
    if (!row) break;
    path.unshift({ id: row.id, name: row.name });
    cur = row.parentId;
  }
  return path;
}

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export async function createOrganisation(user: Actor, input: OrgInput) {
  requireCrm(user);
  const u = await me(user);
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "Give the organisation a name.");
  if (input.parentId) {
    const parent = await db.organisation.findFirst({ where: { id: input.parentId, workspaceId: u.workspaceId } });
    if (!parent) throw new ApiError(400, "Choose a parent organisation that exists.");
    if (parent.archivedAt) throw new ApiError(400, "That parent organisation is archived.");
  }
  const dup = await db.organisation.findFirst({
    where: { workspaceId: u.workspaceId, parentId: input.parentId ?? null, name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (dup && !input.force) {
    throw new ApiError(409, `An organisation called "${dup.name}" already exists here.`, { needsConfirm: "duplicate", existingId: dup.id });
  }
  return db.$transaction(async (tx) => {
    const org = await tx.organisation.create({
      data: { workspaceId: u.workspaceId, name, kind: clean(input.kind), country: clean(input.country), level: input.level ?? null, parentId: input.parentId ?? null, createdById: user.id },
    });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "organisation", targetId: org.id, action: "organisation.created", after: { name, parentId: org.parentId } });
    return org;
  });
}

export async function updateOrganisation(user: Actor, id: string, input: Partial<Omit<OrgInput, "force">>) {
  requireCrm(user);
  const org = await orgOf(user, id);
  requireOrgEdit(user, org);
  if (org.archivedAt) throw new ApiError(409, "This organisation is archived. Unarchive it first.");
  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (k: string, v: unknown, cur: unknown) => { if (v !== undefined && v !== cur) { data[k] = v; before[k] = cur; after[k] = v; } };
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) throw new ApiError(400, "Give the organisation a name.");
    set("name", n, org.name);
  }
  if (input.kind !== undefined) set("kind", clean(input.kind), org.kind);
  if (input.country !== undefined) set("country", clean(input.country), org.country);
  if (input.level !== undefined) set("level", input.level, org.level);
  if (input.parentId !== undefined && input.parentId !== org.parentId) {
    if (input.parentId) {
      const parent = await orgOf(user, input.parentId);
      if (parent.archivedAt) throw new ApiError(400, "That parent organisation is archived.");
      await assertNoCycle(id, input.parentId);
    }
    set("parentId", input.parentId, org.parentId);
  }
  if (!Object.keys(data).length) return org;
  // Editing or moving an account must retain the create flow's same-parent,
  // case-insensitive duplicate guard. Unchanged names remain editable, including
  // duplicates that were deliberately confirmed when they were created.
  if ("name" in data || "parentId" in data) {
    const dup = await db.organisation.findFirst({
      where: {
        workspaceId: org.workspaceId,
        parentId: input.parentId === undefined ? org.parentId : input.parentId,
        id: { not: id },
        name: { equals: "name" in data ? String(data.name) : org.name, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (dup) throw new ApiError(409, `An organisation called "${dup.name}" already exists here.`);
  }
  return db.$transaction(async (tx) => {
    const row = await tx.organisation.update({ where: { id }, data });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "organisation", targetId: id, action: "organisation.updated", before, after });
    if ("parentId" in data) {
      await logAction(tx, { actorId: user.id, projectId: null, targetType: "organisation", targetId: id, action: "organisation.parent_changed", before: { parentId: before.parentId }, after: { parentId: after.parentId }, primary: false });
    }
    return row;
  });
}

/** AC4: an organisation is never deleted; it is archived. */
export async function archiveOrganisation(user: Actor, id: string, archive: boolean) {
  requireCrm(user);
  const org = await orgOf(user, id);
  requireOrgEdit(user, org);
  if (archive === !!org.archivedAt) throw new ApiError(409, archive ? "This organisation is already archived." : "This organisation is not archived.");
  await db.$transaction(async (tx) => {
    await tx.organisation.update({ where: { id }, data: { archivedAt: archive ? new Date() : null } });
    await logAction(tx, {
      actorId: user.id, projectId: null, targetType: "organisation", targetId: id, action: archive ? "organisation.archived" : "organisation.unarchived",
      before: { archivedAt: org.archivedAt?.toISOString() ?? null }, after: { archivedAt: archive ? new Date().toISOString() : null },
    });
  });
}

/** Deals the person may see, as "open deal" counts per organisation (any role on the deal counts). */
export async function visibleOpenDealCounts(user: Actor, orgIds: string[]) {
  if (!orgIds.length) return new Map<string, number>();
  const parties = await db.dealParty.findMany({
    where: {
      organisationId: { in: orgIds },
      project: {
        archivedAt: null,
        stage: { category: { in: ["NOT_STARTED", "ACTIVE", "PAUSED"] } },
        ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }),
      },
    },
    select: { organisationId: true, projectId: true },
  });
  const seen = new Map<string, Set<string>>();
  for (const p of parties) seen.set(p.organisationId, (seen.get(p.organisationId) ?? new Set()).add(p.projectId));
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}

export async function listOrganisations(user: Actor, o: { q?: string; kind?: string; archived?: boolean } = {}) {
  requireCrm(user);
  const u = await me(user);
  const rows = await db.organisation.findMany({
    where: {
      workspaceId: u.workspaceId,
      archivedAt: o.archived ? { not: null } : null,
      ...(o.q?.trim() ? { name: { contains: o.q.trim(), mode: "insensitive" } } : {}),
      ...(o.kind ? { kind: { equals: o.kind, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    take: 500,
    include: { parent: { select: { id: true, name: true } } },
  });
  const counts = await visibleOpenDealCounts(user, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, country: r.country, level: r.level, archived: !!r.archivedAt,
    parent: r.parent, openDeals: counts.get(r.id) ?? 0,
  }));
}

/** Deals where the organisation holds any role, limited to what the viewer may see (SHO-US-12.4 AC2). */
export async function dealsOfOrganisation(user: Actor, orgId: string) {
  const parties = await db.dealParty.findMany({
    where: { organisationId: orgId, project: { ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }) } },
    include: { project: { include: { stage: true, pipeline: true, members: { where: { role: "LEADER" }, include: { user: { select: { id: true, name: true } } } } } } },
    orderBy: { createdAt: "desc" },
  });
  return parties.map((p) => ({
    projectId: p.projectId, name: p.project.name, role: p.role, archived: !!p.project.archivedAt,
    stage: p.project.stage ? { id: p.project.stage.id, name: p.project.stage.name, category: p.project.stage.category } : null,
    pipeline: p.project.pipeline?.name ?? null, leader: p.project.members[0]?.user ?? null,
  }));
}

export async function getOrganisation(user: Actor, id: string) {
  requireCrm(user);
  const org = await orgOf(user, id);
  const [path, children, deals, creator] = await Promise.all([
    orgPath(id),
    db.organisation.findMany({ where: { parentId: id, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } }),
    dealsOfOrganisation(user, id),
    db.user.findUnique({ where: { id: org.createdById }, select: { name: true } }),
  ]);
  return {
    id: org.id, name: org.name, kind: org.kind, country: org.country, level: org.level, archived: !!org.archivedAt,
    parentId: org.parentId, path, children, deals, createdBy: creator?.name ?? null,
    canEdit: canEdit(user, org),
  };
}

/** AC6: History of organisation, contact and note changes is for Admins and the Super Admin only. */
export async function organisationHistory(user: Actor, id: string) {
  requireCrm(user);
  if (!isAdmin(user)) throw notFound("Page");
  const org = await orgOf(user, id);
  const contactIds = (await db.contact.findMany({ where: { organisationId: id }, select: { id: true } })).map((c) => c.id);
  const noteIds = (await db.note.findMany({ where: { organisationId: id }, select: { id: true } })).map((n) => n.id);
  const rows = await db.actionLog.findMany({
    where: { projectId: null, OR: [{ targetType: "organisation", targetId: org.id }, { targetType: "contact", targetId: { in: contactIds } }, { targetType: "note", targetId: { in: noteIds } }] },
    orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), who: r.actor.name, action: r.action, before: r.beforeState, after: r.afterState, undone: !!r.undoneAt }));
}
