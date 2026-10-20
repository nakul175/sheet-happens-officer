// SHO-US-11.2 to 11.5: contacts, notes and task links on organisations. Visible to every signed-in Member except where a
// note belongs to a deal (then deal members and Admins only). Changes are logged with no project; Undo is for 30 days.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { isActive, isAdmin, projectAccess, requireWrite, type Actor, type Tx } from "@/lib/access";
import { WORKSTREAM_DEAL, requireCrm } from "@/lib/crm";
import { formatDueDate, parseDueDate } from "@/lib/dates";
import { logAction } from "@/lib/notify";
import { assertNoCycle, orgOf } from "@/lib/orgs";
import { taskAccess } from "@/lib/tasks";
import { UNDO_LABELS, isTooOldToUndo, isUndoable } from "@/lib/undoable";

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
const NOTE_KINDS = ["MEETING", "CALL", "INTRODUCTION", "OTHER"] as const;
export type NoteKindName = (typeof NOTE_KINDS)[number];
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function me(user: Actor) {
  return db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, workspaceId: true } });
}

/** Notes the person may see: no deal, or a deal they belong to; Admins see all (AC2, AC4). */
export const visibleNotes = (user: Actor): Prisma.NoteWhereInput => ({
  removedAt: null,
  ...(isAdmin(user) ? {} : { OR: [{ projectId: null }, { project: { members: { some: { userId: user.id } } } }] }),
});

// ---------------------------------------------------------------- contacts (11.2)
async function contactOf(user: Actor, id: string, o: { removed?: boolean } = {}) {
  const u = await me(user);
  const c = await db.contact.findFirst({ where: { id, workspaceId: u.workspaceId, ...(o.removed ? {} : { removedAt: null }) } });
  if (!c) throw notFound("Contact");
  return c;
}
const canEditContact = (user: Actor, c: { createdById: string }) => isAdmin(user) || c.createdById === user.id;
function requireContactEdit(user: Actor, c: { createdById: string }) {
  if (!canEditContact(user, c)) throw new ApiError(403, "Only the person who added this contact, or an Admin, can change it.");
}

/** Same visibility and edit checks updateContact runs, so a caller can refuse before reading the body. */
export async function assertCanUpdateContact(user: Actor, id: string) {
  requireCrm(user);
  requireContactEdit(user, await contactOf(user, id));
}

async function knownByList(ids: string[] | undefined, user: Actor, workspaceId: string) {
  const want = [...new Set(ids?.length ? ids : [user.id])];
  const people = await db.user.findMany({ where: { id: { in: want }, workspaceId }, select: { id: true, deactivatedAt: true } });
  if (people.length !== want.length || people.some((p) => p.deactivatedAt)) throw new ApiError(400, "Choose active members for Known by.");
  return want;
}

export async function listContacts(user: Actor, orgId: string) {
  requireCrm(user);
  await orgOf(user, orgId);
  const rows = await db.contact.findMany({
    where: { organisationId: orgId, removedAt: null }, orderBy: { name: "asc" },
    include: { knownBy: true },
  });
  const users = await db.user.findMany({ where: { id: { in: rows.flatMap((r) => r.knownBy.map((k) => k.userId)) } }, select: { id: true, name: true, deactivatedAt: true } });
  const uname = new Map(users.map((x) => [x.id, x]));
  const spoke = await db.noteContact.findMany({
    where: { contactId: { in: rows.map((r) => r.id) }, note: visibleNotes(user) }, select: { contactId: true, note: { select: { date: true } } },
  });
  const last = new Map<string, Date>();
  for (const s of spoke) if (!last.get(s.contactId) || s.note.date > last.get(s.contactId)!) last.set(s.contactId, s.note.date);
  return rows.map((c) => ({
    id: c.id, name: c.name, role: c.role, email: c.email, phone: c.phone, canEdit: canEditContact(user, c),
    knownBy: c.knownBy.map((k) => ({ id: k.userId, name: uname.get(k.userId)?.name ?? "Former member", active: !uname.get(k.userId)?.deactivatedAt })),
    lastSpoke: last.get(c.id) ? dayOf(last.get(c.id)!) : null,
  }));
}

export async function createContact(user: Actor, orgId: string, input: { name: string; role?: string | null; email?: string | null; phone?: string | null; knownBy?: string[] }) {
  requireCrm(user);
  const org = await orgOf(user, orgId);
  if (org.archivedAt) throw new ApiError(409, "This organisation is archived.");
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "Give the contact a name.");
  const u = await me(user);
  const known = await knownByList(input.knownBy, user, u.workspaceId);
  return db.$transaction(async (tx) => {
    const c = await tx.contact.create({ data: { workspaceId: u.workspaceId, organisationId: orgId, name, role: clean(input.role), email: clean(input.email), phone: clean(input.phone), createdById: user.id } });
    await tx.contactKnownBy.createMany({ data: known.map((userId) => ({ contactId: c.id, userId })) });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "contact", targetId: c.id, action: "contact.created", after: { name, organisationId: orgId } });
    return c;
  });
}

export async function updateContact(user: Actor, id: string, input: { name?: string; role?: string | null; email?: string | null; phone?: string | null; knownBy?: string[] }) {
  requireCrm(user);
  const c = await contactOf(user, id);
  requireContactEdit(user, c);
  const u = await me(user);
  const cur = await db.contactKnownBy.findMany({ where: { contactId: id } });
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const data: Record<string, unknown> = {};
  const set = (k: "name" | "role" | "email" | "phone", v: string | null | undefined) => { if (v === undefined) return; const nv = k === "name" ? v?.trim() || null : clean(v); if (k === "name" && !nv) throw new ApiError(400, "Give the contact a name."); if (nv !== c[k]) { data[k] = nv; before[k] = c[k]; after[k] = nv; } };
  set("name", input.name); set("role", input.role); set("email", input.email); set("phone", input.phone);
  let known: string[] | null = null;
  if (input.knownBy !== undefined) {
    known = await knownByList(input.knownBy, user, u.workspaceId);
    const was = cur.map((k) => k.userId).sort();
    if (JSON.stringify([...known].sort()) !== JSON.stringify(was)) { before.knownBy = was; after.knownBy = [...known].sort(); } else known = null;
  }
  if (!Object.keys(after).length) return c;
  return db.$transaction(async (tx) => {
    const row = Object.keys(data).length ? await tx.contact.update({ where: { id }, data }) : c;
    if (known) { await tx.contactKnownBy.deleteMany({ where: { contactId: id } }); await tx.contactKnownBy.createMany({ data: known.map((userId) => ({ contactId: id, userId })) }); }
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "contact", targetId: id, action: "contact.updated", before, after });
    return row;
  });
}

export async function removeContact(user: Actor, id: string) {
  requireCrm(user);
  const c = await contactOf(user, id);
  requireContactEdit(user, c);
  await db.$transaction(async (tx) => {
    await tx.contact.update({ where: { id }, data: { removedAt: new Date() } });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "contact", targetId: id, action: "contact.removed", before: { removedAt: null }, after: { removedAt: new Date().toISOString() } });
  });
}

// ---------------------------------------------------------------- notes (11.3)
export type NoteInput = { kind: NoteKindName; date: string; text: string; projectId?: string | null; contactIds?: string[] };

export async function createNote(user: Actor, orgId: string, input: NoteInput) {
  requireCrm(user);
  const org = await orgOf(user, orgId);
  if (org.archivedAt) throw new ApiError(409, "This organisation is archived.");
  const text = input.text.trim();
  if (!text) throw new ApiError(400, "Write what happened.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) throw new ApiError(400, "Use a date like 2026-10-31.");
  const u = await me(user);
  if (input.projectId) {
    const a = await projectAccess(user, input.projectId); // non-members get "not found"
    if (a.project.typeId !== WORKSTREAM_DEAL) throw new ApiError(400, "Notes can only be linked to a deal.");
    const party = await db.dealParty.findFirst({ where: { projectId: input.projectId, organisationId: orgId } });
    if (!party) throw new ApiError(400, "That deal does not involve this organisation.");
  }
  const contactIds = [...new Set(input.contactIds ?? [])];
  if (contactIds.length) {
    const ok = await db.contact.count({ where: { id: { in: contactIds }, organisationId: orgId, removedAt: null } });
    if (ok !== contactIds.length) throw new ApiError(400, "Choose contacts of this organisation.");
  }
  return db.$transaction(async (tx) => {
    const n = await tx.note.create({
      data: { workspaceId: u.workspaceId, organisationId: orgId, projectId: input.projectId ?? null, kind: input.kind, date: new Date(`${input.date}T00:00:00Z`), text, authorId: user.id },
    });
    if (contactIds.length) await tx.noteContact.createMany({ data: contactIds.map((contactId) => ({ noteId: n.id, contactId })) });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "note", targetId: n.id, action: "note.created", after: { kind: input.kind, organisationId: orgId, dealId: input.projectId ?? null } });
    return n;
  });
}

function presentNotes(rows: Awaited<ReturnType<typeof loadNotes>>, user: Actor, leaderOf: Set<string>) {
  return rows.map((n) => ({
    id: n.id, kind: n.kind, date: dayOf(n.date), text: n.text, author: { id: n.authorId, name: n.author.name }, createdAt: n.createdAt.toISOString(),
    deal: n.project ? { id: n.project.id, name: n.project.name } : null,
    contacts: n.contacts.map((c) => ({ id: c.contact.id, name: c.contact.name })),
    canDelete: isAdmin(user) || n.authorId === user.id || (!!n.projectId && leaderOf.has(n.projectId)),
  }));
}
async function loadNotes(where: Prisma.NoteWhereInput) {
  const rows = await db.note.findMany({
    where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 200,
    include: { project: { select: { id: true, name: true } }, contacts: { select: { contact: { select: { id: true, name: true } } } } },
  });
  const people = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId))] } }, select: { id: true, name: true } });
  const names = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, author: { name: names.get(r.authorId) ?? "Former member" } }));
}
async function leaderSet(user: Actor) {
  const rows = await db.projectMember.findMany({ where: { userId: user.id, role: "LEADER" }, select: { projectId: true } });
  return new Set(rows.map((r) => r.projectId));
}

export async function notesOfOrganisation(user: Actor, orgId: string) {
  requireCrm(user);
  await orgOf(user, orgId);
  return presentNotes(await loadNotes({ organisationId: orgId, ...visibleNotes(user) }), user, await leaderSet(user));
}

export async function notesOfDeal(user: Actor, projectId: string) {
  requireCrm(user);
  const a = await projectAccess(user, projectId);
  if (a.project.typeId !== WORKSTREAM_DEAL) return [];
  return presentNotes(await loadNotes({ projectId, removedAt: null }), user, await leaderSet(user));
}

export async function removeNote(user: Actor, id: string) {
  requireCrm(user);
  const u = await me(user);
  const n = await db.note.findFirst({ where: { id, workspaceId: u.workspaceId, ...visibleNotes(user) } });
  if (!n) throw notFound("Note");
  const leads = n.projectId ? !!(await db.projectMember.findFirst({ where: { projectId: n.projectId, userId: user.id, role: "LEADER" } })) : false;
  if (!(isAdmin(user) || n.authorId === user.id || leads)) throw new ApiError(403, "Only the author, the deal's Leader or an Admin can delete a note.");
  await db.$transaction(async (tx) => {
    await tx.note.update({ where: { id }, data: { removedAt: new Date() } });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: "note", targetId: id, action: "note.removed", before: { removedAt: null }, after: { removedAt: new Date().toISOString() } });
  });
}

// ---------------------------------------------------------------- task links (11.4)
export async function addTaskLink(user: Actor, taskId: string, input: { organisationId?: string | null; contactId?: string | null }) {
  requireCrm(user);
  const t = await db.task.findUnique({ where: { id: taskId } });
  if (!t || t.deletedAt) throw notFound("Task");
  const a = await taskAccess(user, t.projectId, { write: true });
  requireWrite(a);
  if (!!input.organisationId === !!input.contactId) throw new ApiError(400, "Link either an organisation or a contact.");
  let label = "";
  if (input.organisationId) label = (await orgOf(user, input.organisationId)).name;
  else label = (await contactOf(user, input.contactId!)).name;
  const dup = await db.taskLink.findFirst({ where: { taskId, organisationId: input.organisationId ?? null, contactId: input.contactId ?? null } });
  if (dup) throw new ApiError(409, "This task is already linked there.");
  return db.$transaction(async (tx) => {
    const l = await tx.taskLink.create({ data: { taskId, organisationId: input.organisationId ?? null, contactId: input.contactId ?? null } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: taskId, action: "task.link_added", after: { linkId: l.id, organisationId: l.organisationId, contactId: l.contactId, label } });
    return l;
  });
}

export async function removeTaskLink(user: Actor, taskId: string, linkId: string) {
  requireCrm(user);
  const t = await db.task.findUnique({ where: { id: taskId } });
  if (!t || t.deletedAt) throw notFound("Task");
  const a = await taskAccess(user, t.projectId, { write: true });
  requireWrite(a);
  const l = await db.taskLink.findFirst({ where: { id: linkId, taskId } });
  if (!l) throw notFound("Link");
  await db.$transaction(async (tx) => {
    await tx.taskLink.delete({ where: { id: linkId } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: taskId, action: "task.link_removed", before: { linkId, organisationId: l.organisationId, contactId: l.contactId } });
  });
}

export async function linksOfTask(taskId: string) {
  const rows = await db.taskLink.findMany({ where: { taskId }, include: { organisation: { select: { id: true, name: true } }, contact: { select: { id: true, name: true, organisationId: true, removedAt: true } } }, orderBy: { createdAt: "asc" } });
  return rows.filter((l) => !l.contact?.removedAt).map((l) => ({ id: l.id, organisation: l.organisation, contact: l.contact ? { id: l.contact.id, name: l.contact.name, organisationId: l.contact.organisationId } : null }));
}

/** AC2, AC4: tasks linked to the organisation or one of its contacts, only in projects the viewer belongs to (Admins: all). Trash and archived are left out. */
export async function tasksLinkedHere(user: Actor, o: { organisationId?: string; contactId?: string }) {
  const rows = await db.task.findMany({
    where: {
      deletedAt: null,
      project: { archivedAt: null, ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }) },
      links: { some: o.contactId ? { contactId: o.contactId } : { OR: [{ organisationId: o.organisationId }, { contact: { organisationId: o.organisationId, removedAt: null } }] } },
    },
    orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { dueDate: { sort: "asc", nulls: "last" } }], take: 100,
    include: { assignee: { select: { name: true } }, project: { select: { id: true, name: true, typeId: true } } },
  });
  return rows.map((t) => ({ id: t.id, title: t.title, done: !!t.completedAt, dueDate: formatDueDate(t.dueDate), assignee: t.assignee.name, project: { id: t.project.id, name: t.project.name, type: t.project.typeId === WORKSTREAM_DEAL ? "DEAL" : "PROJECT" } }));
}

export async function getContact(user: Actor, id: string) {
  requireCrm(user);
  const c = await contactOf(user, id);
  const list = (await listContacts(user, c.organisationId)).find((x) => x.id === id)!;
  return { ...list, organisationId: c.organisationId, tasks: await tasksLinkedHere(user, { contactId: id }) };
}

// ---------------------------------------------------------------- the organisation tree (11.5 AC1)
export async function orgTree(user: Actor, orgId: string) {
  const u = await me(user);
  const all = await db.organisation.findMany({ where: { workspaceId: u.workspaceId, archivedAt: null }, select: { id: true, name: true, parentId: true }, take: 2000 });
  const byParent = new Map<string | null, typeof all>();
  for (const o of all) byParent.set(o.parentId, [...(byParent.get(o.parentId) ?? []), o]);
  const byId = new Map(all.map((o) => [o.id, o]));
  let root = byId.get(orgId);
  if (!root) return null;
  for (let i = 0; i < 50 && root.parentId && byId.get(root.parentId); i++) root = byId.get(root.parentId)!;
  type Node = { id: string; name: string; children: Node[] };
  let count = 0;
  const build = (o: { id: string; name: string }, depth: number): Node => ({ id: o.id, name: o.name, children: depth > 6 || count++ > 300 ? [] : (byParent.get(o.id) ?? []).map((c) => build(c, depth + 1)) });
  return build(root, 0);
}

// ---------------------------------------------------------------- Undo for records logged without a project (6.4 for CRM)
type RecPlan = { conflicts: { field: string; before: unknown; after: unknown; now: unknown }[]; apply: (tx: Tx) => Promise<void> };
const norm = (v: unknown) => JSON.stringify(v === undefined ? null : v);
const diff = (keys: string[], b: Record<string, unknown>, f: Record<string, unknown>, now: Record<string, unknown>) =>
  keys.filter((k) => norm(now[k]) !== norm(f[k])).map((k) => ({ field: k, before: b[k], after: f[k], now: now[k] }));

async function planRecord(row: { action: string; targetId: string; beforeState: unknown; afterState: unknown }, user: Actor): Promise<RecPlan> {
  const b = (row.beforeState ?? {}) as Record<string, unknown>;
  const f = (row.afterState ?? {}) as Record<string, unknown>;
  const id = row.targetId;
  const bad = (m: string) => new ApiError(409, m);
  switch (row.action) {
    case "organisation.created": case "organisation.archived": case "organisation.unarchived": {
      const o = await db.organisation.findUnique({ where: { id } });
      if (!o) throw bad("This organisation no longer exists.");
      // Undo reverses the logged action. Creating an organisation is undone by archiving it.
      const archive = row.action === "organisation.created" || row.action === "organisation.unarchived";
      if (archive === !!o.archivedAt) throw bad(archive ? "This organisation is already archived." : "This organisation is not archived any more.");
      return { conflicts: [], apply: async (tx) => { await tx.organisation.update({ where: { id }, data: { archivedAt: archive ? new Date() : null } }); } };
    }
    case "organisation.updated": {
      const o = await db.organisation.findUnique({ where: { id } });
      if (!o) throw bad("This organisation no longer exists.");
      const keys = Object.keys(f);
      if (keys.includes("parentId") && b.parentId) await assertNoCycle(id, b.parentId as string);
      return { conflicts: diff(keys, b, f, { name: o.name, kind: o.kind, country: o.country, level: o.level, parentId: o.parentId }), apply: async (tx) => { await tx.organisation.update({ where: { id }, data: Object.fromEntries(keys.map((k) => [k, b[k] ?? null])) }); } };
    }
    case "contact.created": case "contact.removed": {
      const c = await db.contact.findUnique({ where: { id } });
      if (!c) throw bad("This contact no longer exists.");
      const remove = row.action === "contact.created";
      if (remove === !!c.removedAt) throw bad(remove ? "This contact is already removed." : "This contact is already back.");
      return { conflicts: [], apply: async (tx) => { await tx.contact.update({ where: { id }, data: { removedAt: remove ? new Date() : null } }); } };
    }
    case "contact.updated": {
      const c = await db.contact.findUnique({ where: { id }, include: { knownBy: true } });
      if (!c || c.removedAt) throw bad("This contact no longer exists.");
      const keys = Object.keys(f);
      const now: Record<string, unknown> = { name: c.name, role: c.role, email: c.email, phone: c.phone, knownBy: c.knownBy.map((k) => k.userId).sort() };
      return {
        conflicts: diff(keys, b, f, now),
        apply: async (tx) => {
          const data = Object.fromEntries(keys.filter((k) => k !== "knownBy").map((k) => [k, b[k] ?? null]));
          if (Object.keys(data).length) await tx.contact.update({ where: { id }, data });
          if (keys.includes("knownBy")) { await tx.contactKnownBy.deleteMany({ where: { contactId: id } }); await tx.contactKnownBy.createMany({ data: (b.knownBy as string[]).map((userId) => ({ contactId: id, userId })) }); }
        },
      };
    }
    case "note.created": case "note.removed": {
      const n = await db.note.findUnique({ where: { id } });
      if (!n) throw bad("This note no longer exists.");
      const remove = row.action === "note.created";
      if (remove === !!n.removedAt) throw bad(remove ? "This note is already deleted." : "This note is already back.");
      return { conflicts: [], apply: async (tx) => { await tx.note.update({ where: { id }, data: { removedAt: remove ? new Date() : null } }); } };
    }
  }
  void user;
  throw bad("This kind of action cannot be undone.");
}

export async function undoRecord(user: Actor, row: { id: string; action: string; actorId: string; targetType: string; targetId: string; createdAt: Date; undoneAt: Date | null; beforeState: unknown; afterState: unknown }, anyway: boolean) {
  requireCrm(user);
  if (row.actorId !== user.id && !isAdmin(user)) throw new ApiError(403, "You can only undo your own actions.");
  if (row.undoneAt) throw new ApiError(409, "This action was already undone.");
  if (!isUndoable(row.action)) throw new ApiError(409, "This kind of action cannot be undone.");
  if (isTooOldToUndo(row.createdAt)) throw new ApiError(409, "Too old to undo", { tooOld: true });
  const p = await planRecord(row, user);
  if (p.conflicts.length && !anyway) {
    throw new ApiError(409, "This changed after your action.", { needsConfirm: "conflict", label: UNDO_LABELS[row.action], changedBy: [], conflicts: p.conflicts.map((c) => ({ field: c.field, before: String(c.before ?? "none"), after: String(c.after ?? "none"), now: String(c.now ?? "none") })) });
  }
  await db.$transaction(async (tx) => {
    await p.apply(tx);
    await tx.actionLog.update({ where: { id: row.id }, data: { undoneAt: new Date(), undoneById: user.id } });
    await logAction(tx, { actorId: user.id, projectId: null, targetType: row.targetType as "task", targetId: row.targetId, action: "undo", before: { undoes: row.id, action: row.action }, after: { undoes: row.id, label: UNDO_LABELS[row.action], anyway: anyway && p.conflicts.length > 0 } });
  });
  return { label: UNDO_LABELS[row.action], noticesSent: false, overrode: anyway && p.conflicts.length > 0 };
}
export { parseDueDate, isActive };
