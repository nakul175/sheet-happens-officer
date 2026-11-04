// SHO-US-11.1: organisations with a parent tree. Visible to every signed-in Member (owner decision
// 17 Oct 2026); only the creator and Admins edit or archive. Changes are logged with no project.
import { db } from "@/lib/db";
import type { Organisation } from "@/generated/prisma/client";
import { ApiError, notFound } from "@/lib/http";
import { isActive, isAdmin, type Actor, type Tx } from "@/lib/access";
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

async function withLockedOrgEdit<T>(user: Actor, id: string, apply: (tx: Tx, org: Organisation) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    let org;
    let account;
    try {
      await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${id} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR SHARE NOWAIT`;
      org = await tx.organisation.findUnique({ where: { id } });
      account = await tx.user.findUnique({ where: { id: user.id }, select: { workspaceId: true, orgRole: true, deactivatedAt: true, emailVerifiedAt: true } });
    } catch (error) {
      if ((error as { code?: string; meta?: { code?: string } }).code === "P2010" && (error as { meta?: { code?: string } }).meta?.code === "55P03") {
        throw new ApiError(409, "This organisation or its access is changing. Reload and try again.");
      }
      throw error;
    }
    if (!org || !account || !isActive(account) || account.workspaceId !== org.workspaceId) throw notFound("Organisation");
    const currentActor = { ...user, orgRole: account.orgRole };
    requireCrm(currentActor);
    requireOrgEdit(currentActor, org);
    return apply(tx, org);
  }, { isolationLevel: "ReadCommitted" });
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

/** Hold the current ancestry steady while a parent change or its Undo commits. */
export async function assertSafeParentTx(tx: Tx, orgId: string, parentId: string, workspaceId: string) {
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (depth >= 50 || current === orgId) throw new ApiError(409, "That parent would make an organisation cycle.");
    try {
      await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${current} FOR SHARE NOWAIT`;
    } catch (error) {
      if ((error as { code?: string; meta?: { code?: string } }).code === "P2010" && (error as { meta?: { code?: string } }).meta?.code === "55P03") {
        throw new ApiError(409, "The organisation tree is changing. Reload and try again.");
      }
      throw error;
    }
    const parent: { parentId: string | null; workspaceId: string; archivedAt: Date | null } | null = await tx.organisation.findUnique({ where: { id: current }, select: { parentId: true, workspaceId: true, archivedAt: true } });
    if (!parent || parent.workspaceId !== workspaceId || (depth === 0 && parent.archivedAt)) throw new ApiError(409, "The parent organisation is no longer available.");
    current = parent.parentId;
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
  return withLockedOrgEdit(user, id, async (tx, fresh) => {
    if (fresh.archivedAt) throw new ApiError(409, "This organisation is archived. Unarchive it first.");
    if (["name", "kind", "country", "level", "parentId"].some((key) => fresh[key as keyof typeof fresh] !== org[key as keyof typeof org]) || !!fresh.archivedAt !== !!org.archivedAt) {
      throw new ApiError(409, "This organisation changed while you were editing. Reload and try again.");
    }
    if ("parentId" in data && data.parentId) await assertSafeParentTx(tx, id, data.parentId as string, fresh.workspaceId);
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
  await withLockedOrgEdit(user, id, async (tx, fresh) => {
    if (archive === !!fresh.archivedAt) throw new ApiError(409, archive ? "This organisation is already archived." : "This organisation is not archived.");
    const archivedAt = archive ? new Date() : null;
    await tx.organisation.update({ where: { id }, data: { archivedAt } });
    await logAction(tx, {
      actorId: user.id, projectId: null, targetType: "organisation", targetId: id, action: archive ? "organisation.archived" : "organisation.unarchived",
      before: { archivedAt: fresh.archivedAt?.toISOString() ?? null }, after: { archivedAt: archivedAt?.toISOString() ?? null },
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
    orderBy: [{ name: "asc" }, { id: "asc" }],
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
