// SHO-US-13.3: the Monday pipeline review. Everything is limited to what the viewer may see.
import { db } from "@/lib/db";
import { isAdmin, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmVisible, requireCrm } from "@/lib/crm";
import { formatDueDate, startOfTodayIST } from "@/lib/dates";
import { listDeals } from "@/lib/deals";

export const IDEA_STALE_DAYS = 30;

export async function leadsAnyDeal(user: Actor) {
  if (!crmVisible(user)) return false;
  if (isAdmin(user)) return true;
  return !!(await db.projectMember.findFirst({ where: { userId: user.id, role: "LEADER", project: { typeId: WORKSTREAM_DEAL, archivedAt: null } }, select: { projectId: true } }));
}

export async function pipelineReview(user: Actor, now = Date.now()) {
  requireCrm(user);
  const deals = (await listDeals(user, {}, now)).filter((d) => !d.archived);
  const today = startOfTodayIST(new Date(now));
  const todayStr = formatDueDate(today)!;
  const pick = (d: (typeof deals)[number]) => ({ id: d.id, name: d.name, stage: d.stage?.name ?? null, pipeline: d.pipeline?.name ?? null, organisation: d.organisation, leader: d.leader, nextStep: d.nextStep });
  const working = deals.filter((d) => d.stage && ["NOT_STARTED", "ACTIVE"].includes(d.stage.category));
  const needsNextStep = working.filter((d) => d.needsNextStep).map(pick);
  const overdueNextStep = working.filter((d) => d.nextStep?.dueDate && d.nextStep.dueDate < todayStr).map(pick);
  const stalled = deals.filter((d) => d.stalled).map((d) => ({ ...pick(d), lastActivity: d.lastActivity }));

  const cutoff = new Date(now - IDEA_STALE_DAYS * 86400_000);
  const ideaRows = await db.task.findMany({
    where: {
      isIdea: true, completedAt: null, deletedAt: null, parentId: null, createdAt: { lt: cutoff },
      project: { archivedAt: null, typeId: { not: WORKSTREAM_DEAL }, ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }) },
    },
    orderBy: { createdAt: "asc" }, take: 100,
    include: { assignee: { select: { id: true, name: true } }, project: { select: { id: true, name: true, members: { where: { userId: user.id }, select: { role: true } } } } },
  });
  const ideas = ideaRows.map((t) => ({
    id: t.id, title: t.title, dueDate: formatDueDate(t.dueDate), createdAt: t.createdAt.toISOString(), assignee: t.assignee, project: { id: t.project.id, name: t.project.name },
    canEdit: isAdmin(user) || (t.project.members[0]?.role ?? "VIEWER") !== "VIEWER",
  }));

  // Pipeline counts by stage; unknown value is never zero.
  const pipes = await db.pipeline.findMany({ where: { typeId: WORKSTREAM_DEAL }, orderBy: { position: "asc" }, include: { stages: { orderBy: { position: "asc" } } } });
  const counts = pipes.map((p) => ({
    id: p.id, name: p.name,
    stages: p.stages.map((s) => {
      const here = deals.filter((d) => d.stage?.id === s.id);
      const sums = new Map<string, number>();
      let withoutValue = 0;
      for (const d of here) { if (d.value === null || !d.currency) withoutValue++; else sums.set(d.currency, (sums.get(d.currency) ?? 0) + d.value); }
      return { id: s.id, name: s.name, category: s.category, count: here.length, sums: [...sums].map(([currency, total]) => ({ currency, total })), withoutValue };
    }),
  }));
  return { needsNextStep, overdueNextStep, stalled, ideas, counts };
}
