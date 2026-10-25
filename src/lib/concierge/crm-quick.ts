// SHO-2584: deterministic attention query, never a model call or a CRM mutation.
import { db } from "@/lib/db";
import { projectAccess, crmVisible, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, requireCrm } from "@/lib/crm";
import { listDeals, OPEN_CATEGORIES } from "@/lib/deals";
import { ApiError } from "@/lib/http";
import { formatDueDate, startOfTodayIST } from "@/lib/dates";
import { flat } from "@/lib/concierge/reads";
export const CRM_ATTENTION_ACTION = { id: "deals-attention" as const, label: "Deals needing attention" };
export async function canOfferDealAttention(user: Actor) {
  if (!crmVisible(user)) return false;
  // project-lookup-ok: CRM-visible + explicit active Deal Leader membership; only an ID is read.
  return !!(await db.project.findFirst({
    where: { typeId: WORKSTREAM_DEAL, archivedAt: null, members: { some: { userId: user.id, role: "LEADER" } }, stage: { category: { in: [...OPEN_CATEGORIES] } } }, select: { id: true },
  }));
}
export async function dealAttentionAnswer(user: Actor, now = new Date(), projectId?: string) {
  requireCrm(user);
  if (projectId) {
    const access = await projectAccess(user, projectId);
    if (access.project.typeId !== WORKSTREAM_DEAL || access.project.archivedAt) throw new ApiError(404, "Project not found");
  }
  const today = formatDueDate(startOfTodayIST(now))!;
  const rows = (await listDeals(user, { mine: true, lifecycle: "sales" })).filter(row =>
    row.leader?.id === user.id && !!row.stage && (OPEN_CATEGORIES as readonly string[]).includes(row.stage.category) && (!projectId || row.id === projectId));
  const needing = rows.filter(row => row.needsNextStep || row.stalled || !!(row.nextStep && row.nextStep.dueDate < today));
  const items = needing.slice(0, 25).map(row => {
    const reasons = [row.needsNextStep ? "needs a next step" : null, row.nextStep && row.nextStep.dueDate < today ? `overdue next step: ${flat(row.nextStep.title)} (${row.nextStep.dueDate})` : null, row.stalled ? "Stalled" : null].filter(Boolean);
    return { id: row.id, name: flat(row.name), line: `${flat(row.name)} (${reasons.join("; ")})` };
  });
  return {
    q: CRM_ATTENTION_ACTION,
    text: items.length ? `${CRM_ATTENTION_ACTION.label}: ${items.length}${needing.length > 25 ? "+" : ""}\n${items.map(row => `- ${row.line}`).join("\n")}` : "I found nothing.",
    links: items.map(row => ({ label: row.name, href: `/projects/${row.id}` })),
  };
}
