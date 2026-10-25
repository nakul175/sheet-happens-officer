// SHO-2584: model-facing CRM records, projected from the same services as the screens.
import type { Actor } from "@/lib/access";
import { requireCrm } from "@/lib/crm";
import { listOrganisations, getOrganisation } from "@/lib/orgs";
import { getContact, listContacts, notesOfOrganisation, notesOfDeal } from "@/lib/records";
import { ApiError, notFound } from "@/lib/http";
import { flat } from "@/lib/concierge/reads";
export type NamedCrmRec = { id: string; name: string };
export type OrganisationRec = NamedCrmRec & { kind: string | null; country: string | null; path?: NamedCrmRec[]; children?: NamedCrmRec[]; openDeals?: number; deals?: (NamedCrmRec & { stage: string | null; pipeline: string | null })[]; moreDeals?: boolean };
export type ContactRec = NamedCrmRec & { organisation: NamedCrmRec; role: string | null; email: string | null; phone: string | null };
export type NoteRec = { id: string; kind: string; date: string; text: string; more?: string; author: string; deal: NamedCrmRec | null };
const nullable = (value: string | null) => value == null ? null : flat(value);
const named = (value: NamedCrmRec): NamedCrmRec => ({ id: value.id, name: flat(value.name) });
export async function findOrganisations(user: Actor, text: string) {
  requireCrm(user);
  if (flat(text).length < 2) return { organisations: [] as OrganisationRec[], truncated: false };
  const rows = await listOrganisations(user, { q: flat(text) });
  return { organisations: rows.slice(0, 25).map(row => ({ ...named(row), kind: nullable(row.kind), country: nullable(row.country), openDeals: row.openDeals })), truncated: rows.length > 25 };
}
export async function organisationSummary(user: Actor, id: string): Promise<OrganisationRec> {
  requireCrm(user);
  const org = await getOrganisation(user, id);
  if (org.archived) throw notFound("Organisation");
  const visibleDeals = org.deals.filter(deal => !deal.archived);
  // getOrganisation owns membership filtering; no unfiltered deal query or edit/history fields enter the model.
  return { ...named(org), kind: nullable(org.kind), country: nullable(org.country), path: org.path.map(named), children: org.children.slice(0, 25).map(named), deals: visibleDeals.slice(0, 25).map(deal => ({ id: deal.projectId, name: flat(deal.name), stage: deal.stage ? flat(deal.stage.name) : null, pipeline: nullable(deal.pipeline) })), moreDeals: visibleDeals.length > 25 };
}
export async function findContacts(user: Actor, organisationId: string, text = "") {
  requireCrm(user);
  const org = await organisationSummary(user, organisationId);
  const q = flat(text).toLocaleLowerCase();
  const rows = (await listContacts(user, organisationId)).filter(row => !q || flat(row.name).toLocaleLowerCase().includes(q) || (row.email ?? "").toLocaleLowerCase().includes(q));
  return { contacts: rows.slice(0, 25).map(row => ({ ...named(row), organisation: named(org), role: nullable(row.role), email: nullable(row.email), phone: nullable(row.phone) })), truncated: rows.length > 25 };
}
export async function contactById(user: Actor, id: string): Promise<ContactRec | null> {
  try {
    requireCrm(user);
    const contact = await getContact(user, id);
    const org = await organisationSummary(user, contact.organisationId);
    return { ...named(contact), organisation: named(org), role: nullable(contact.role), email: nullable(contact.email), phone: nullable(contact.phone) };
  } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}
export async function organisationById(user: Actor, id: string) {
  try { return await organisationSummary(user, id); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}
export async function crmNotes(user: Actor, target: { organisationId: string } | { dealId: string }) {
  requireCrm(user);
  const rows = "organisationId" in target
    ? (await organisationSummary(user, target.organisationId), await notesOfOrganisation(user, target.organisationId))
    : await notesOfDeal(user, target.dealId);
  const notes: NoteRec[] = rows.slice(0, 5).map(row => {
    const text = flat(row.text);
    return { id: row.id, kind: row.kind, date: row.date, text: text.slice(0, 300), ...(text.length > 300 ? { more: `+${text.length - 300} more characters` } : {}), author: flat(row.author.name), deal: row.deal ? named(row.deal) : null };
  });
  return { notes, truncated: rows.length > 5 };
}
export function crmRecordLinks(records: { organisations: Iterable<OrganisationRec>; contacts: Iterable<ContactRec>; notes: Iterable<NoteRec> }, text: string) {
  const lower = text.toLocaleLowerCase(), links = new Map<string, { label: string; href: string }>();
  const add = (value: NamedCrmRec, href: string) => { if (value.name.length >= 3 && lower.includes(value.name.toLocaleLowerCase())) links.set(`${href}|${value.name}`, { label: value.name, href }); };
  for (const org of records.organisations) {
    for (const item of [org, ...(org.path ?? []), ...(org.children ?? [])]) add(item, `/accounts/${item.id}`);
    for (const deal of org.deals ?? []) add(deal, `/projects/${deal.id}`);
  }
  for (const contact of records.contacts) { add(contact, `/accounts/${contact.organisation.id}`); add(contact.organisation, `/accounts/${contact.organisation.id}`); }
  for (const note of records.notes) if (note.deal) add(note.deal, `/projects/${note.deal.id}`);
  return [...links.values()];
}
