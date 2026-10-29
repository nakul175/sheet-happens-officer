// SHO-2584: trimmed, read-only CRM records. Access is checked afresh on every call.
import { db } from "@/lib/db";
import { projectAccess, type Actor } from "@/lib/access";
import { crmVisible, requireCrm, WORKSTREAM_DEAL } from "@/lib/crm";
import { listDeals, isWorking, OPEN_CATEGORIES } from "@/lib/deals";
import { getOrganisation, listOrganisations, orgOf } from "@/lib/orgs";
import { listContacts, notesOfDeal, notesOfOrganisation } from "@/lib/records";
import { ApiError } from "@/lib/http";
import { startOfTodayIST } from "@/lib/dates";
import { flat, visibleProjects } from "@/lib/concierge/reads";

export const CRM_LIMIT = 25;
export const NOTE_LIMIT = 5;
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const page = <T>(rows: T[], limit: number) => ({ items: rows.slice(0, limit), truncated: rows.length > limit });
async function workspace(user: Actor) {
  requireCrm(user);
  return (await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } })).workspaceId;
}

async function visibleDeals(user: Actor) {
  const workspaceId = await workspace(user);
  // Scope independently of listDeals' admin-wide screen query: other workspaces never reach a tool result.
  const allowed = await db.project.findMany({ where: { ...visibleProjects(user), workspaceId, typeId: WORKSTREAM_DEAL }, select: { id: true } });
  const ids = new Set(allowed.map((p) => p.id));
  return (await listDeals(user)).filter((d) => ids.has(d.id)).map((d) => ({
    id: d.id, name: flat(d.name),
    pipeline: d.pipeline ? { id: d.pipeline.id, name: flat(d.pipeline.name) } : null,
    stage: d.stage ? { id: d.stage.id, name: flat(d.stage.name), category: d.stage.category } : null,
    organisation: d.organisation ? { id: d.organisation.id, name: flat(d.organisation.name) } : null,
    nextStep: d.nextStep ? { ...d.nextStep, title: flat(d.nextStep.title) } : null,
    stalled: d.stalled, needsNextStep: d.needsNextStep,
  })).sort(byName);
}
export type DealRec = Awaited<ReturnType<typeof visibleDeals>>[number];
export async function findDeals(user: Actor, text = "") {
  const q = flat(text).toLowerCase();
  const rows = (await visibleDeals(user)).filter((d) => d.name.toLowerCase().includes(q));
  return page(rows, CRM_LIMIT);
}
export async function dealSummary(user: Actor, id: string): Promise<DealRec | null> {
  return (await visibleDeals(user)).find((d) => d.id === id) ?? null;
}

export async function findOrganisations(user: Actor, text = "") {
  requireCrm(user);
  const rows = (await listOrganisations(user, { q: text })).map((o) => ({ id: o.id, name: flat(o.name), kind: o.kind ? flat(o.kind) : null, country: o.country ? flat(o.country) : null, openDeals: o.openDeals })).sort(byName);
  return page(rows, CRM_LIMIT);
}
export type OrganisationRec = Awaited<ReturnType<typeof findOrganisations>>["items"][number];
export async function organisationSummary(user: Actor, id: string) {
  requireCrm(user);
  const o = await getOrganisation(user, id);
  if (o.archived) return null;
  // No nested deal/child lists: each further record must be fetched through its authorized read tool.
  return { id: o.id, name: flat(o.name), kind: o.kind ? flat(o.kind) : null, country: o.country ? flat(o.country) : null, openDeals: o.deals.filter((d) => !d.archived && d.stage && (OPEN_CATEGORIES as readonly string[]).includes(d.stage.category)).length };
}

export async function findContacts(user: Actor, text = "", organisationId?: string) {
  const workspaceId = await workspace(user);
  if (organisationId) await orgOf(user, organisationId);
  const candidates = await db.contact.findMany({
    where: { workspaceId, removedAt: null, organisation: { archivedAt: null }, ...(organisationId ? { organisationId } : {}), ...(text.trim() ? { name: { contains: text.trim(), mode: "insensitive" } } : {}) },
    select: { id: true, organisationId: true, organisation: { select: { name: true } } }, orderBy: [{ name: "asc" }, { id: "asc" }], take: CRM_LIMIT + 1,
  });
  const orgIds = [...new Set(candidates.map((c) => c.organisationId))];
  const contacts = new Map(await Promise.all(orgIds.map(async (id) => [id, await listContacts(user, id)] as const)));
  const rows = candidates.flatMap((c) => {
    const item = contacts.get(c.organisationId)?.find((r) => r.id === c.id);
    return item ? [{ id: item.id, name: flat(item.name), role: item.role ? flat(item.role) : null, email: item.email ? flat(item.email) : null, phone: item.phone ? flat(item.phone) : null, organisation: { id: c.organisationId, name: flat(c.organisation.name) } }] : [];
  });
  return page(rows, CRM_LIMIT);
}
export type ContactRec = Awaited<ReturnType<typeof findContacts>>["items"][number];
export async function contactById(user: Actor, id: string): Promise<ContactRec | null> {
  const workspaceId = await workspace(user);
  const c = await db.contact.findFirst({ where: { id, workspaceId, removedAt: null, organisation: { archivedAt: null } }, select: { organisationId: true, name: true } });
  return c ? (await findContacts(user, c.name, c.organisationId)).items.find((x) => x.id === id) ?? null : null;
}

export function noteExcerpt(text: string) {
  const characters = Array.from(flat(text));
  const remainingCharacters = Math.max(0, characters.length - 300);
  return { text: characters.slice(0, 300).join(""), remainingCharacters, ...(remainingCharacters ? { moreText: `+${remainingCharacters} more characters` } : {}) };
}
export async function readNotes(user: Actor, scope: { dealId?: string; organisationId?: string }) {
  requireCrm(user);
  if (!!scope.dealId === !!scope.organisationId) throw new ApiError(400, "Choose one deal or organisation for notes.");
  if (scope.dealId) {
    const a = await projectAccess(user, scope.dealId);
    if (a.project.workspaceId !== await workspace(user) || !await dealSummary(user, scope.dealId)) throw new ApiError(404, "Not found.");
  } else if ((await orgOf(user, scope.organisationId!)).archivedAt) throw new ApiError(404, "Not found.");
  const rows = scope.dealId ? await notesOfDeal(user, scope.dealId) : await notesOfOrganisation(user, scope.organisationId!);
  const notes = rows.map((n) => ({ id: n.id, kind: n.kind, date: n.date, ...noteExcerpt(n.text), author: flat(n.author.name) }));
  return page(notes, NOTE_LIMIT);
}

export async function dealsNeedingAttention(user: Actor, now = new Date()) {
  requireCrm(user);
  const today = startOfTodayIST(now).toISOString().slice(0, 10);
  const rows = (await visibleDeals(user)).filter((d) => isWorking(d.stage?.category) && (d.needsNextStep || d.stalled || !!(d.nextStep?.dueDate && d.nextStep.dueDate < today)));
  return page(rows, CRM_LIMIT);
}
export const offersCrm = (user: Actor) => crmVisible(user);
