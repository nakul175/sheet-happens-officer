// SHO-2584, first read-only slice. Existing CRM/project services own visibility and membership.
import { projectAccess, type Actor } from "@/lib/access";
import { requireCrm, WORKSTREAM_DEAL } from "@/lib/crm";
import { listDeals, dealBlock } from "@/lib/deals";
import { ApiError, notFound } from "@/lib/http";
import { flat } from "@/lib/concierge/reads";

export type DealRec = {
  id: string; name: string; pipeline: string | null; stage: string | null;
  organisation: { id: string; name: string } | null;
  nextStep: { id: string; title: string; due: string } | null;
  stalled: boolean; needsNextStep: boolean;
};
type Projection = Pick<Awaited<ReturnType<typeof listDeals>>[number], "pipeline" | "stage" | "nextStep" | "stalled" | "needsNextStep"> & { organisation: { id: string; name: string } | null };
function present(id: string, name: string, row: Projection): DealRec {
  return {
    id, name: flat(name), pipeline: row.pipeline ? flat(row.pipeline.name) : null,
    stage: row.stage ? flat(row.stage.name) : null,
    organisation: row.organisation ? { id: row.organisation.id, name: flat(row.organisation.name) } : null,
    nextStep: row.nextStep ? { id: row.nextStep.id, title: flat(row.nextStep.title), due: row.nextStep.dueDate } : null,
    stalled: row.stalled, needsNextStep: row.needsNextStep,
  };
}
export async function findDeals(user: Actor, text: string) {
  requireCrm(user);
  const q = flat(text).toLocaleLowerCase();
  if (q.length < 2) return { deals: [] as DealRec[], truncated: false };
  const rows = (await listDeals(user, { lifecycle: "all" })).filter(row => flat(row.name).toLocaleLowerCase().includes(q));
  return { deals: rows.slice(0, 25).map(row => present(row.id, row.name, row)), truncated: rows.length > 25 };
}
export async function dealSummary(user: Actor, id: string): Promise<DealRec> {
  requireCrm(user);
  const { project } = await projectAccess(user, id);
  if (project.typeId !== WORKSTREAM_DEAL || project.archivedAt) throw notFound("Deal");
  // dealBlock has no actor argument: call only after exact-ID access and live Deal checks above.
  const row = await dealBlock(id);
  if (!row) throw notFound("Deal");
  return present(project.id, project.name, row);
}
export async function dealById(user: Actor, id: string) {
  try { return await dealSummary(user, id); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}
export function crmDealLinks(deals: Iterable<DealRec>, text: string) {
  const lower = text.toLocaleLowerCase();
  return [...deals].filter(row => row.name.length >= 3 && lower.includes(row.name.toLocaleLowerCase())).map(row => ({ label: row.name, href: `/projects/${row.id}` }));
}
