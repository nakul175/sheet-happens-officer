// SHO-US-13.3: the Monday pipeline review. Everything is limited to what the viewer may see.
import { db } from "@/lib/db";
import { isAdmin, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmVisible, requireCrm } from "@/lib/crm";
import { formatDueDate, startOfTodayIST } from "@/lib/dates";
import { listDeals } from "@/lib/deals";

export const IDEA_STALE_DAYS = 30;
export const REVIEW_TIMELINES = ["all", "overdue", "30d", "90d"] as const;
export type ReviewTimeline = (typeof REVIEW_TIMELINES)[number];

const OPEN_HEADLINE_CATEGORIES = new Set(["NOT_STARTED", "ACTIVE", "PAUSED"]);

function inTimeline(deadline: string | null | undefined, timeline: ReviewTimeline, today: string) {
  if (timeline === "all") return true;
  if (!deadline) return false;
  if (timeline === "overdue") return deadline < today;
  const end = new Date(`${today}T00:00:00.000+05:30`);
  end.setUTCDate(end.getUTCDate() + (timeline === "30d" ? 30 : 90));
  return deadline >= today && deadline <= formatDueDate(end)!;
}

export async function leadsAnyDeal(user: Actor) {
  if (!crmVisible(user)) return false;
  if (isAdmin(user)) return true;
  return !!(await db.projectMember.findFirst({ where: { userId: user.id, role: "LEADER", project: { typeId: WORKSTREAM_DEAL, archivedAt: null } }, select: { projectId: true } }));
}

export async function pipelineReview(user: Actor, timeline: ReviewTimeline = "all") {
  requireCrm(user);
  const deals = (await listDeals(user)).filter((d) => !d.archived);
  const today = startOfTodayIST();
  const todayStr = formatDueDate(today)!;
  const pick = (d: (typeof deals)[number]) => ({ id: d.id, name: d.name, stage: d.stage?.name ?? null, pipeline: d.pipeline?.name ?? null, organisation: d.organisation, leader: d.leader, nextStep: d.nextStep });
  const working = deals.filter((d) => d.stage && ["NOT_STARTED", "ACTIVE"].includes(d.stage.category));
  const needsNextStep = working.filter((d) => d.needsNextStep).map(pick);
  const overdueNextStep = working.filter((d) => d.nextStep?.dueDate && d.nextStep.dueDate < todayStr).map(pick);
  const stalled = deals.filter((d) => d.stalled).map((d) => ({ ...pick(d), lastActivity: d.lastActivity }));

  const cutoff = new Date(Date.now() - IDEA_STALE_DAYS * 86400_000);
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

  // Opportunity-type reporting uses the canonical persisted type. Operational
  // queues above still include every visible deal. Unknown value is never zero
  // and currency totals are never combined.
  const pipes = await db.pipeline.findMany({ where: { typeId: WORKSTREAM_DEAL }, orderBy: { position: "asc" }, include: { stages: { orderBy: { position: "asc" } } } });
  const timelineDeals = deals.filter((d) => inTimeline(d.submissionDeadline, timeline, todayStr));
  const countsFor = (include: (deal: (typeof deals)[number]) => boolean) => pipes.map((p) => ({
    id: p.id, name: p.name,
    stages: p.stages.map((s) => {
      const here = timelineDeals.filter((d) => d.stage?.id === s.id && include(d));
      const sums = new Map<string, number>();
      let withoutValue = 0;
      for (const d of here) { if (d.value === null || !d.currency) withoutValue++; else sums.set(d.currency, (sums.get(d.currency) ?? 0) + d.value); }
      return { id: s.id, name: s.name, category: s.category, count: here.length, sums: [...sums].map(([currency, total]) => ({ currency, total })), withoutValue };
    }),
  }));
  const commercial = (d: (typeof deals)[number]) => d.opportunityType === "RFP_RFA" || d.opportunityType === "OTC";
  const other = (d: (typeof deals)[number]) => d.opportunityType === "EOI" || d.opportunityType === "CV_LTA";
  const unclassified = (d: (typeof deals)[number]) => !d.opportunityType;
  const openCommercialCount = timelineDeals.filter((d) => commercial(d) && OPEN_HEADLINE_CATEGORIES.has(d.stage?.category ?? "")).length;
  return {
    needsNextStep, overdueNextStep, stalled, ideas,
    counts: countsFor(commercial), otherCounts: countsFor(other), unclassifiedCounts: countsFor(unclassified),
    timeline, openCommercialCount,
    headlineRule: "Open commercial includes Not started, Active and On hold; Won, Lost and Ongoing/Delivery outcomes stay visible by stage but are excluded from the headline.",
  };
}
