import { assertBidSubmissionFields, guardBidSubmissionWrite } from "@/lib/bid-submission-policy";
import { parseSubmissionDeadline, serializeSubmissionDeadline } from "@/lib/submission-deadline";
// SHO-E10 and SHO-E12: Deals are projects of type Deal. This file holds creation, stages, details,
// next step and stalled logic. Access is still project membership (src/lib/access.ts).
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { isActive, isAdmin, projectAccess, requireWrite, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmMode, crmProjectWhere, crmVisible, requireCrm } from "@/lib/crm";
import { formatDueDate, parseDueDate } from "@/lib/dates";
import { auditTx, logAction, notify } from "@/lib/notify";
import { orgOf } from "@/lib/orgs";
import { taskAccess } from "@/lib/tasks";

import { dealClassificationFields, type DealClassificationInput } from "@/lib/deal-classification";

export const STALL_DAYS = 30;
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];
export const OPEN_CATEGORIES = ["NOT_STARTED", "ACTIVE", "PAUSED"] as const;
const WORKING_CATEGORIES = ["NOT_STARTED", "ACTIVE"] as const; // "Needs a next step" and "Stalled" apply to these only

export type Currency = "INR" | "USD" | "EUR";
export type DealDetailsInput = DealClassificationInput & {
  whyPursue?: string; need?: string | null; serviceLine?: string | null; value?: number | null; currency?: Currency | null;
  probability?: number | null; expectedClose?: string | null; introducedBy?: string | null; submissionDeadline?: string | null;
};

function classification(input: DealClassificationInput) {
  const parsed = dealClassificationFields.safeParse(input);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}
const revenueNumber = (value: unknown): number | null => value == null ? null : Number(value);

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
const isoDate = (s: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ApiError(400, "Use a date like 2026-10-31."); return new Date(`${s}T00:00:00Z`); };
const dayOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
function deadlinePatch(value: string | null | undefined) {
  try { const parsed = parseSubmissionDeadline(value ?? null); return { submissionDeadline: parsed.deadline, submissionDeadlineHasTime: parsed.hasTime }; }
  catch { throw new ApiError(400, "Use a valid submission date, with an optional time and timezone."); }
}
function deadlineAudit(value: string | null | undefined) {
  const patch = deadlinePatch(value);
  return { submissionDeadline: serializeSubmissionDeadline(patch.submissionDeadline, patch.submissionDeadlineHasTime), submissionDeadlineHasTime: patch.submissionDeadlineHasTime };
}

/** Pipelines with their stages, for pickers and the board. Type Deal only. */
export async function dealPipelines(user: Actor) {
  requireCrm(user);
  const pipes = await db.pipeline.findMany({ where: { typeId: WORKSTREAM_DEAL }, orderBy: { position: "asc" }, include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } });
  return pipes.map((p) => ({
    id: p.id, key: p.key, name: p.name,
    stages: p.stages.map((s) => ({ id: s.id, name: s.name, position: s.position, category: s.category, needsReason: s.needsReason, requiredFields: s.requiredFields })),
  }));
}

function normaliseValue(v: number | null | undefined, c: Currency | null | undefined) {
  if (v === null || v === undefined) return { value: null, currency: null as Currency | null };
  if (!(v > 0)) throw new ApiError(400, "Enter a value above zero, or leave it empty if it is not known yet.");
  if (!c) throw new ApiError(400, "Choose a currency for the value.");
  return { value: v, currency: c };
}
function checkProbability(p: number | null | undefined) {
  if (p === null || p === undefined) return null;
  if (!Number.isInteger(p) || p < 0 || p > 100) throw new ApiError(400, "Probability is a whole number from 0 to 100.");
  return p;
}

/** SHO-US-12.1. One transaction: the project, its Leader, Sections, details, the Buyer and the first next step. */
export async function createDeal(
  user: Actor,
  input: DealDetailsInput & {
    name: string; organisationId: string; pipelineId: string; leaderId: string; whyPursue: string;
    nextStep: { title: string; dueDate: string }; force?: boolean;
  },
) {
  requireCrm(user);
  const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "Give the deal a name.");
  if (!input.organisationId) throw new ApiError(400, "Choose an organisation.");
  const org = await orgOf(user, input.organisationId).catch(() => { throw new ApiError(400, "Choose an organisation."); });
  if (org.archivedAt) throw new ApiError(400, "That organisation is archived.");
  const pipeline = await db.pipeline.findFirst({ where: { id: input.pipelineId, typeId: WORKSTREAM_DEAL }, include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } });
  if (!pipeline) throw new ApiError(400, "Choose a pipeline.");
  const first = pipeline.stages[0];
  const why = input.whyPursue?.trim();
  if (!why) throw new ApiError(400, "Say in one line why to pursue this.");
  const step = input.nextStep?.title?.trim();
  if (!step || !input.nextStep.dueDate) throw new ApiError(400, "Add a first next step with a date.");
  isoDate(input.nextStep.dueDate);
  const isBid = pipeline.key === "DEAL_BID";
  if (isBid && !input.submissionDeadline) throw new ApiError(400, "A bid needs a submission deadline.");
  const leader = await db.user.findUnique({ where: { id: input.leaderId } });
  if (!leader || !isActive(leader) || leader.workspaceId !== u.workspaceId) throw new ApiError(400, "Choose an active person as Leader.");
  const { value, currency } = normaliseValue(input.value, input.currency);
  const probability = checkProbability(input.probability);
  const classifications = classification(input);
  assertBidSubmissionFields(pipeline.key, first.id, { ...input, probability, ...classifications });

  // project-lookup-ok: Workspace-wide duplicate confirmation for the supplied name and buyer, after requireCrm; includes archived deals.
  const dup = await db.project.findFirst({
    where: { workspaceId: u.workspaceId, typeId: WORKSTREAM_DEAL, name: { equals: name, mode: "insensitive" }, parties: { some: { organisationId: org.id, role: "BUYER" } } },
    select: { id: true },
  });
  if (dup && !input.force) throw new ApiError(409, `A deal called "${name}" already exists for ${org.name}.`, { needsConfirm: "duplicate", existingId: dup.id });

  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { workspaceId: u.workspaceId, name, typeId: WORKSTREAM_DEAL, pipelineId: pipeline.id, stageId: first.id, stageChangedAt: new Date() },
    });
    await tx.projectMember.create({ data: { projectId: project.id, userId: leader.id, role: "LEADER" } });
    if (leader.id !== user.id) await tx.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "EDITOR" } });
    const sections = [];
    for (const [i, n] of DEFAULT_SECTIONS.entries()) {
      sections.push(await tx.section.create({ data: { projectId: project.id, name: n, position: i, isDone: i === DEFAULT_SECTIONS.length - 1 } }));
    }
    await tx.dealDetails.create({
      data: {
        projectId: project.id, workspaceId: u.workspaceId, whyPursue: why, need: clean(input.need), serviceLine: clean(input.serviceLine),
        value, currency, probability, ...classifications, expectedClose: input.expectedClose ? isoDate(input.expectedClose) : null,
        introducedBy: clean(input.introducedBy), ...deadlinePatch(input.submissionDeadline),
      },
    });
    await tx.dealParty.create({ data: { projectId: project.id, organisationId: org.id, role: "BUYER" } });
    const firstStep = await tx.task.create({
      data: {
        workspaceId: u.workspaceId, projectId: project.id, sectionId: sections[0].id, title: step, dueDate: parseDueDate(input.nextStep.dueDate),
        assigneeId: leader.id, createdById: user.id,
      },
    });
    // The first step is a task like any other: the Leader hears they hold it and the log shows it was created (SHO-BUG-5).
    // Not the primary row: the Undo toast after creating a deal must not offer to undo its required first step.
    await notify(tx, [leader.id], "TASK_ASSIGNED", { actorId: user.id, taskId: firstStep.id, projectId: project.id, data: { title: firstStep.title } });
    await logAction(tx, { actorId: user.id, projectId: project.id, targetType: "task", targetId: firstStep.id, action: "task.created", after: { title: firstStep.title, assigneeId: leader.id, sectionId: sections[0].id, parentId: null }, primary: false });
    await notify(tx, [leader.id], "MADE_LEADER", { actorId: user.id, projectId: project.id, data: { project: project.name } });
    await logAction(tx, { actorId: user.id, projectId: project.id, targetType: "deal", targetId: project.id, action: "deal.created", after: { name, organisationId: org.id, pipeline: pipeline.name, leaderId: leader.id, ...classifications, ...deadlineAudit(input.submissionDeadline) } });
    return project;
  });
}

// ---- stages (SHO-US-10.3) ----

/** Tasks still open on a deal, including subtasks. Won and Lost refuse while any of these remain. */
export function blockingTaskWhere(projectId: string) {
  return { projectId, deletedAt: null, completedAt: null };
}

async function openTasks(projectId: string) {
  return db.task.findMany({ where: blockingTaskWhere(projectId), select: { id: true, title: true, parentId: true }, orderBy: { createdAt: "asc" } });
}

/** AC6: how many tasks are still open, and the first 20, in the order they were created. */
export function openTaskBlock(open: { id: string; title: string }[]) {
  return { openTasks: open.length, tasks: open.slice(0, 20).map((t) => ({ id: t.id, title: t.title })) };
}

const FIELD_NAMES: Record<string, string> = {
  whyPursue: "why to pursue", need: "need", serviceLine: "service line", value: "value", probability: "probability",
  expectedClose: "expected close", submissionDeadline: "submission deadline", introducedBy: "introduced by",
};
function missingFields(required: string[], d: Record<string, unknown>) {
  return required.filter((k) => d[k] === null || d[k] === undefined || d[k] === "");
}

export async function moveStage(user: Actor, projectId: string, input: { stageId: string; reason?: string | null; fields?: DealDetailsInput }) {
  requireCrm(user);
  const a = await projectAccess(user, projectId, { write: true });
  requireWrite(a);
  if (a.project.typeId !== WORKSTREAM_DEAL || !a.project.pipelineId) throw new ApiError(400, "Only deals have stages.");
  const stage = await db.stage.findFirst({ where: { id: input.stageId, pipelineId: a.project.pipelineId } });
  if (!stage || stage.isRetired) throw new ApiError(400, "Choose an active stage from this deal's pipeline.");
  const cur = a.project.stageId ? await db.stage.findUnique({ where: { id: a.project.stageId } }) : null;
  if (stage.category === "DELIVERY") {
    const pipeline = await db.pipeline.findUnique({ where: { id: a.project.pipelineId }, select: { key: true } });
    if (pipeline?.key !== "DEAL_BID") throw new ApiError(400, "Delivery is available only in the Bid pipeline.");
    if (cur?.id !== stage.id && cur?.id !== "st_bid_won") throw new ApiError(409, "Mark this Bid deal Won before moving it to Ongoing Projects.");
  }
  if (cur?.id === stage.id) return { stage };
  const reason = clean(input.reason);
  if (stage.needsReason && !reason) throw new ApiError(400, `Say why this deal is moving to "${stage.name}".`, { needsReason: true });

  // AC6: a deal cannot be won or lost while any task is open. Nothing is closed or archived for the person.
  if (stage.category === "DONE" || stage.category === "LOST") {
    const open = await openTasks(projectId);
    if (open.length) {
      throw new ApiError(409, `${open.length} task${open.length === 1 ? " is" : "s are"} still open. Complete or delete ${open.length === 1 ? "it" : "them"} before marking this deal ${stage.name}.`, openTaskBlock(open));
    }
  }
  const details = await db.dealDetails.findUnique({ where: { projectId } });
  if (!details) throw new ApiError(500, "This deal has no details.");

  // AC3: required fields may be supplied in the same request; otherwise the move is refused and the dialog asks.
  const merged: Record<string, unknown> = { ...details, ...stripUndefined(input.fields ?? {}) };
  const missing = missingFields(stage.requiredFields, merged);
  if (missing.length) {
    throw new ApiError(409, `Fill in ${missing.map((k) => FIELD_NAMES[k] ?? k).join(", ")} first.`, { needsFields: missing });
  }

  return db.$transaction(async (tx) => {
    const fresh = await guardBidSubmissionWrite(tx, projectId, input.fields ?? {}, stage.id, a.project.pipelineId);
    if (input.fields && Object.keys(stripUndefined(input.fields)).length) await applyDetails(tx, projectId, input.fields, fresh);
    const stagePatch = { stageId: stage.id, stageReason: reason, stageChangedAt: new Date() };
    if (stage.category === "DELIVERY") {
      // Do not let a concurrent commercial move turn an earlier Won read into a delivery bypass.
      const changed = await tx.project.updateMany({ where: { id: projectId, pipelineId: a.project.pipelineId, stageId: "st_bid_won" }, data: stagePatch });
      if (changed.count !== 1) throw new ApiError(409, "This deal's stage changed. Refresh before moving it to Ongoing Projects.");
    } else {
      try { await tx.project.update({ where: { id: projectId, pipelineId: a.project.pipelineId }, data: stagePatch }); }
      catch (error) { if ((error as { code?: string }).code === "P2025") throw new ApiError(409, "This deal's pipeline changed. Refresh before moving its stage."); throw error; }
    }
    const leader = a.project.members.find((m) => m.role === "LEADER")!.userId;
    await notify(tx, [leader], "DEAL_STAGE_CHANGED", { actorId: user.id, projectId, data: { project: a.project.name, stage: stage.name } });
    await logAction(tx, {
      actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.stage_changed",
      before: { stageId: cur?.id ?? null, stage: cur?.name ?? null, reason: a.project.stageReason ?? null },
      after: { stageId: stage.id, stage: stage.name, reason },
    });
    if (stage.category === "DONE" || stage.category === "LOST") {
      await auditTx(tx, "DEAL_CLOSED", { actorId: user.id, targetId: projectId, targetType: "deal", data: { projectId, stage: stage.name } });
    }
    return { stage };
  });
}

const stripUndefined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

type DetailsRow = Awaited<ReturnType<typeof db.dealDetails.findUniqueOrThrow>>;

function detailsState(d: DetailsRow | Record<string, unknown>) {
  const r = d as DetailsRow;
  return {
    whyPursue: r.whyPursue, need: r.need, serviceLine: r.serviceLine, value: r.value === null || r.value === undefined ? null : Number(r.value), currency: r.currency,
    opportunityType: r.opportunityType ?? null, athenaEntity: r.athenaEntity ?? null, netFeeRevenueUsd: revenueNumber(r.netFeeRevenueUsd),
    probability: r.probability, expectedClose: r.expectedClose ? dayOnly(r.expectedClose) : null, introducedBy: r.introducedBy,
    submissionDeadline: serializeSubmissionDeadline(r.submissionDeadline, r.submissionDeadlineHasTime),
    submissionDeadlineHasTime: r.submissionDeadlineHasTime ?? false,
  };
}

/** Builds a Prisma update from a validated patch. Returns what changed for the action log. */
function detailsPatch(input: DealDetailsInput, cur: DetailsRow) {
  const data: Prisma.DealDetailsUpdateInput = { ...classification(input) };
  if (input.whyPursue !== undefined) { const v = input.whyPursue.trim(); if (!v) throw new ApiError(400, "Say in one line why to pursue this."); data.whyPursue = v; }
  if (input.need !== undefined) data.need = clean(input.need);
  if (input.serviceLine !== undefined) data.serviceLine = clean(input.serviceLine);
  if (input.value !== undefined || input.currency !== undefined) {
    const v = input.value !== undefined ? input.value : cur.value === null ? null : Number(cur.value);
    const c = input.currency !== undefined ? input.currency : cur.currency;
    const n = normaliseValue(v, c);
    data.value = n.value; data.currency = n.currency;
  }
  if (input.probability !== undefined) data.probability = checkProbability(input.probability);
  if (input.expectedClose !== undefined) data.expectedClose = input.expectedClose ? isoDate(input.expectedClose) : null;
  if (input.introducedBy !== undefined) data.introducedBy = clean(input.introducedBy);
  if (input.submissionDeadline !== undefined) Object.assign(data, deadlinePatch(input.submissionDeadline));
  return data;
}

async function applyDetails(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], projectId: string, input: DealDetailsInput, cur: DetailsRow) {
  const data = detailsPatch(input, cur);
  if (Object.keys(data).length) await tx.dealDetails.update({ where: { projectId }, data });
}

const isOpenCategory = (c: string) => (OPEN_CATEGORIES as readonly string[]).includes(c);

/**
 * SHO-US-10.2 AC3 (APL-2736). The Super Admin removes a deal stage. Without `moveTo` nothing is removed:
 * the answer is 409 and asks which other stage of the same pipeline its items should move to.
 * A target must not let a move skip a rule moveStage applies: open stays open, Won stays Won, Lost stays Lost,
 * and the target asks for no reason or field the removed stage did not already ask for.
 */
export async function removeStage(user: Actor, stageId: string, input: { moveTo?: string | null }) {
  requireCrm(user);
  if (user.orgRole !== "SUPER_ADMIN") throw notFound("Stage");
  const stage = await db.stage.findFirst({ where: { id: stageId, pipeline: { typeId: WORKSTREAM_DEAL } }, include: { pipeline: { include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } } } });
  if (!stage) throw notFound("Stage");
  if (stage.isRetired) throw new ApiError(409, "This retired stage is preserved for history and Undo and cannot be removed.");
  const others = stage.pipeline.stages.filter((s) => s.id !== stage.id);
  if (stage.category === "DONE" && !others.some((s) => s.category === "DONE")) {
    throw new ApiError(409, `${stage.pipeline.name} must keep a Done stage, so "${stage.name}" cannot be removed.`);
  }
  const canTake = (t: (typeof others)[number]) =>
    !t.isRetired && (isOpenCategory(stage.category) ? isOpenCategory(t.category) : t.category === stage.category) &&
    !(t.needsReason && !stage.needsReason) && t.requiredFields.every((f) => stage.requiredFields.includes(f));
  // Only the stages that can take the items are offered; with none, nothing is asked.
  const targets = others.filter(canTake);
  if (!targets.length) {
    throw new ApiError(409, `No other stage in ${stage.pipeline.name} can take the items in "${stage.name}", so it cannot be removed.`);
  }
  // project-lookup-ok: removeStage requires SUPER_ADMIN and counts every item that must be moved.
  const items = await db.project.count({ where: { stageId: stage.id } });
  const moveTo = clean(input.moveTo);
  if (!moveTo) {
    throw new ApiError(409, `Where should the ${items} item${items === 1 ? "" : "s"} in "${stage.name}" go? Choose another stage to move ${items === 1 ? "it" : "them"} to before removing this stage.`, {
      needsMoveTo: true, items, stages: targets.map((s) => ({ id: s.id, name: s.name, category: s.category })),
    });
  }
  const target = others.find((s) => s.id === moveTo);
  if (!target) throw new ApiError(400, `Choose another stage from ${stage.pipeline.name}.`);
  if (!canTake(target)) throw new ApiError(400, `Items in "${stage.name}" cannot move to "${target.name}". Choose a stage of the same kind.`);

  return db.$transaction(async (tx) => {
    // Lock the stage row first. A deal being moved into it meanwhile either commits before this lock, and is moved
    // below, or waits and then fails, because the stage is gone. The stageId foreign key is ON DELETE SET NULL (see
    // prisma/migrations/20261017124803_crm_workstreams_deals), so the delete below would silently clear a deal's stage
    // instead of refusing: the updateMany on the next line, which moves every project off the stage first, is what
    // keeps a deal from losing it.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Stage" WHERE "id" = ${stage.id} FOR UPDATE`;
    if (!locked.length) throw notFound("Stage");
    const affected = await tx.project.findMany({ where: { stageId: stage.id }, select: { id: true }, orderBy: { id: "asc" } });
    for (const project of affected) await guardBidSubmissionWrite(tx, project.id, {}, target.id, stage.pipeline.id);
    // A reason was given for the removed stage. It carries over only to a stage that also asks for one.
    const moved = await tx.project.updateMany({
      where: { stageId: stage.id },
      data: { stageId: target.id, stageChangedAt: new Date(), ...(target.needsReason ? {} : { stageReason: null }) },
    });
    await tx.stage.delete({ where: { id: stage.id } });
    await auditTx(tx, "STAGE_REMOVED", {
      actorId: user.id, targetId: stage.id, targetType: "stage",
      data: { pipeline: stage.pipeline.name, stage: stage.name, movedTo: target.name, movedToId: target.id, items: moved.count },
    });
    return { removed: { id: stage.id, name: stage.name }, movedTo: { id: target.id, name: target.name }, items: moved.count };
  });
}

/** Edits the facts on a deal. Editors and the Leader may; Viewers and archived deals are refused. */
export async function updateDealDetails(user: Actor, projectId: string, input: DealDetailsInput) {
  requireCrm(user);
  const a = await projectAccess(user, projectId, { write: true });
  requireWrite(a);
  if (a.project.typeId !== WORKSTREAM_DEAL) throw new ApiError(400, "Only deals have these details.");
  const cur = await db.dealDetails.findUnique({ where: { projectId } });
  if (!cur) throw notFound("Deal");
  const data = detailsPatch(input, cur);
  if (!Object.keys(data).length) return;
  const before = detailsState(cur);
  await db.$transaction(async (tx) => {
    await guardBidSubmissionWrite(tx, projectId, data);
    const next = await tx.dealDetails.update({ where: { projectId }, data });
    const after = detailsState(next);
    const keys = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    await logAction(tx, {
      actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.details_updated",
      before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: Object.fromEntries(keys.map((k) => [k, after[k]])),
    });
  });
}

// ---- reading deals: next step, stalled, lists ----

type SummaryProject = { id: string; stage: { category: string } | null; stageChangedAt: Date | null; createdAt: Date };

/** Next step (earliest-due open task) and last activity for a set of deals (SHO-US-12.5, 12.7). */
export async function dealSignals(projects: SummaryProject[]) {
  const ids = projects.map((p) => p.id);
  const none = new Map<string, { nextStep: { id: string; title: string; dueDate: string } | null; lastActivity: Date }>();
  if (!ids.length) return none;
  const [tasks, logs, taskTouch, notes] = await Promise.all([
    db.task.findMany({
      where: { projectId: { in: ids }, deletedAt: null, completedAt: null, parentId: null, dueDate: { not: null } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], select: { id: true, title: true, dueDate: true, projectId: true },
    }),
    db.actionLog.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, action: { not: "undo" } }, _max: { createdAt: true } }),
    db.task.groupBy({ by: ["projectId"], where: { projectId: { in: ids } }, _max: { updatedAt: true } }),
    db.note.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, removedAt: null }, _max: { createdAt: true } }),
  ]);
  const next = new Map<string, { id: string; title: string; dueDate: string }>();
  for (const t of tasks) if (!next.has(t.projectId)) next.set(t.projectId, { id: t.id, title: t.title, dueDate: formatDueDate(t.dueDate)! });
  const maxOf = (rows: { projectId: string | null; _max: Record<string, Date | null> }[], key: string) => new Map(rows.map((r) => [r.projectId ?? "", r._max[key]] as const));
  const l = maxOf(logs, "createdAt"), tt = maxOf(taskTouch, "updatedAt"), nn = maxOf(notes, "createdAt");
  for (const p of projects) {
    const times = [p.createdAt, p.stageChangedAt, l.get(p.id), tt.get(p.id), nn.get(p.id)].filter((x): x is Date => !!x);
    none.set(p.id, { nextStep: next.get(p.id) ?? null, lastActivity: new Date(Math.max(...times.map((x) => x.getTime()))) });
  }
  return none;
}

export const isWorking = (category: string | null | undefined) => !!category && (WORKING_CATEGORIES as readonly string[]).includes(category);
export const isStalled = (category: string | null | undefined, lastActivity: Date, now = Date.now()) =>
  isWorking(category) && now - lastActivity.getTime() > STALL_DAYS * 86400_000;

const visibleTo = (user: Actor): Prisma.ProjectWhereInput => (isAdmin(user) ? {} : { members: { some: { userId: user.id } } });

/** SHO-US-12.6 data and the Deals screen. `mine` limits to deals the person leads or holds a task in (AC6). */
export async function listDeals(user: Actor, o: { archived?: boolean; mine?: boolean; pipelineId?: string; lifecycle?: "sales" | "delivery" | "all" } = {}) {
  requireCrm(user);
  // project-lookup-ok: requireCrm plus visibleTo enforces role/membership; archive filter is explicitly selected by the caller.
  const projects = await db.project.findMany({
    where: {
      typeId: WORKSTREAM_DEAL, archivedAt: o.archived ? { not: null } : null, ...visibleTo(user),
      ...(o.pipelineId ? { pipelineId: o.pipelineId } : {}),
      ...(o.lifecycle === "delivery" ? { stage: { category: "DELIVERY" } } : o.lifecycle === "sales" ? { OR: [{ stageId: null }, { stage: { category: { not: "DELIVERY" } } }] } : {}),
      ...(o.mine ? { AND: [{ OR: [{ members: { some: { userId: user.id, role: "LEADER" } } }, { tasks: { some: { assigneeId: user.id, deletedAt: null, completedAt: null } } }] }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      stage: true, pipeline: true, deal: true,
      members: { where: { role: "LEADER" }, include: { user: { select: { id: true, name: true } } } },
      parties: { where: { role: "BUYER" }, include: { organisation: { select: { id: true, name: true } } } },
    },
  });
  const signals = await dealSignals(projects);
  const now = Date.now();
  return projects.map((p) => {
    const sig = signals.get(p.id)!;
    return {
      id: p.id, name: p.name, archived: !!p.archivedAt,
      lifecycle: p.stage?.category === "DELIVERY" ? "delivery" as const : "sales" as const,
      pipeline: p.pipeline ? { id: p.pipeline.id, key: p.pipeline.key, name: p.pipeline.name } : null,
      stage: p.stage ? { id: p.stage.id, name: p.stage.name, category: p.stage.category, isRetired: p.stage.isRetired } : null,
      organisation: p.parties[0]?.organisation ?? null, leader: p.members[0]?.user ?? null,
      value: p.deal?.value === null || p.deal?.value === undefined ? null : Number(p.deal.value), currency: p.deal?.currency ?? null,
      opportunityType: p.deal?.opportunityType ?? null, athenaEntity: p.deal?.athenaEntity ?? null, netFeeRevenueUsd: revenueNumber(p.deal?.netFeeRevenueUsd),
      probability: p.deal?.probability ?? null,
      submissionDeadline: serializeSubmissionDeadline(p.deal?.submissionDeadline, p.deal?.submissionDeadlineHasTime),
      submissionDeadlineHasTime: p.deal?.submissionDeadlineHasTime ?? false,
      nextStep: sig.nextStep,
      needsNextStep: isWorking(p.stage?.category) && !p.archivedAt && !sig.nextStep,
      stalled: !p.archivedAt && isStalled(p.stage?.category, sig.lastActivity, now),
      lastActivity: sig.lastActivity.toISOString(),
    };
  });
}

/** The deal block on the project page: details, parties, pipeline stages, next step and flags. */
export async function dealBlock(projectId: string) {
  // project-lookup-ok: dealBlock is called only by getProject after projectAccess authorizes this exact ID.
  const p = await db.project.findUnique({
    where: { id: projectId },
    include: { stage: true, pipeline: { include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } }, deal: true, parties: { include: { organisation: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } } },
  });
  if (!p || p.typeId !== WORKSTREAM_DEAL) return null;
  const sig = (await dealSignals([p])).get(p.id)!;
  const d = p.deal;
  return {
    pipeline: p.pipeline ? { id: p.pipeline.id, key: p.pipeline.key, name: p.pipeline.name, stages: p.pipeline.stages.map((s) => ({ id: s.id, name: s.name, category: s.category, needsReason: s.needsReason, requiredFields: s.requiredFields })) } : null,
    stage: p.stage ? { id: p.stage.id, name: p.stage.name, category: p.stage.category, isRetired: p.stage.isRetired } : null,
    stageReason: p.stageReason,
    details: d ? {
      whyPursue: d.whyPursue, need: d.need, serviceLine: d.serviceLine, value: d.value === null ? null : Number(d.value), currency: d.currency,
      opportunityType: d.opportunityType ?? null, athenaEntity: d.athenaEntity ?? null, netFeeRevenueUsd: revenueNumber(d.netFeeRevenueUsd),
      probability: d.probability, expectedClose: dayOnly(d.expectedClose), introducedBy: d.introducedBy, submissionDeadline: serializeSubmissionDeadline(d.submissionDeadline, d.submissionDeadlineHasTime), submissionDeadlineHasTime: d.submissionDeadlineHasTime ?? false,
    } : null,
    parties: p.parties.map((x) => ({ id: x.id, role: x.role, organisation: x.organisation })),
    organisation: p.parties.find((x) => x.role === "BUYER")?.organisation ?? null,
    nextStep: sig.nextStep,
    needsNextStep: isWorking(p.stage?.category) && !p.archivedAt && !sig.nextStep,
    stalled: !p.archivedAt && isStalled(p.stage?.category, sig.lastActivity),
  };
}


/** SHO-US-12.5 AC2: when a working deal is left with no dated open task, the Leader gets one notice (none while an unread one stands). */
export async function ensureNextStep(tx: Prisma.TransactionClient, projectId: string, actorId: string | null) {
  const p = await tx.project.findUnique({ where: { id: projectId }, select: { name: true, typeId: true, archivedAt: true, stage: { select: { category: true } } } });
  if (!p || p.typeId !== WORKSTREAM_DEAL || p.archivedAt || !isWorking(p.stage?.category)) return;
  const open = await tx.task.count({ where: { projectId, deletedAt: null, completedAt: null, parentId: null, dueDate: { not: null } } });
  if (open > 0) return;
  const leader = await tx.projectMember.findFirst({ where: { projectId, role: "LEADER" }, select: { userId: true } });
  if (!leader) return;
  const unread = await tx.notification.count({ where: { recipientId: leader.userId, projectId, type: "DEAL_NEEDS_NEXT_STEP", readAt: null } });
  if (unread) return;
  await notify(tx, [leader.userId], "DEAL_NEEDS_NEXT_STEP", { actorId, projectId, data: { project: p.name }, includeActor: true });
}

export type PartyRoleName = "BUYER" | "FUNDER" | "IMPLEMENTING_OFFICE" | "PARTNER" | "OTHER";

/** SHO-US-12.4: parties are organisations. One Buyer (set at creation); other roles repeat. Archived organisations cannot be added. */
export async function addParty(user: Actor, projectId: string, organisationId: string, role: PartyRoleName) {
  requireCrm(user);
  const a = await projectAccess(user, projectId);
  requireWrite(a);
  if (role === "BUYER") throw new ApiError(400, "A deal has one Buyer, set when the deal is created.");
  const org = await orgOf(user, organisationId);
  if (org.archivedAt) throw new ApiError(400, "That organisation is archived and cannot be added to a deal.");
  const dup = await db.dealParty.findFirst({ where: { projectId, organisationId, role } });
  if (dup) throw new ApiError(409, "That organisation already has this role on the deal.");
  await db.$transaction(async (tx) => {
    const row = await tx.dealParty.create({ data: { projectId, organisationId, role } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.party_added", after: { partyId: row.id, organisation: org.name, role } });
  });
}

export async function removeParty(user: Actor, projectId: string, partyId: string) {
  requireCrm(user);
  const a = await projectAccess(user, projectId);
  requireWrite(a);
  const row = await db.dealParty.findFirst({ where: { id: partyId, projectId }, include: { organisation: { select: { name: true } } } });
  if (!row) throw notFound("Party");
  if (row.role === "BUYER") throw new ApiError(400, "The Buyer cannot be removed. Every deal has one.");
  await db.$transaction(async (tx) => {
    await tx.dealParty.delete({ where: { id: partyId } });
    await logAction(tx, { actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.party_removed", before: { organisation: row.organisation.name, role: row.role } });
  });
}


// ---- SHO-US-12.2: convert a task into a deal ----
export type ConvertInput = DealDetailsInput & {
  organisationId?: string; pipelineId?: string; name?: string; leaderId?: string; whyPursue?: string; dueDate?: string | null; force?: boolean;
};

export async function convertTaskToDeal(user: Actor, taskId: string, input: ConvertInput) {
  requireCrm(user);
  const t = await db.task.findUnique({ where: { id: taskId }, include: { collaborators: { select: { userId: true } } } });
  if (!t || t.deletedAt) throw notFound("Task");
  const a = await taskAccess(user, t.projectId, { write: true });
  requireWrite(a);
  if (a.project.typeId === WORKSTREAM_DEAL) throw new ApiError(400, "Only a task in a project can be converted to a deal.");
  if (t.parentId) throw new ApiError(400, "A subtask cannot be converted. Convert its parent task.");
  if (t.completedAt) throw new ApiError(409, "A completed task cannot become a deal. Reopen it first.");
  if (t.approverId && t.assigneeId === t.approverId) throw new ApiError(409, "This task is waiting for approval. Close it or send it back before converting.");

  const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const name = (input.name ?? t.title).trim();
  const leaderId = input.leaderId ?? t.assigneeId;
  const why = input.whyPursue?.trim();
  const dueDate = input.dueDate ?? (t.dueDate ? formatDueDate(t.dueDate) : null);
  const pipeline = input.pipelineId ? await db.pipeline.findFirst({ where: { id: input.pipelineId, typeId: WORKSTREAM_DEAL }, include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } }) : null;

  // The gate (AC2): every field, same refusal as the dialog. No bypass.
  const missing: string[] = [];
  if (!input.organisationId) missing.push("organisation");
  if (!pipeline) missing.push("pipeline");
  if (!name) missing.push("name");
  if (!why) missing.push("whyPursue");
  if (!dueDate) missing.push("dueDate");
  if (pipeline?.key === "DEAL_BID" && !input.submissionDeadline) missing.push("submissionDeadline");
  if (pipeline) {
    const merged: Record<string, unknown> = { ...input, whyPursue: why };
    assertBidSubmissionFields(pipeline.key, pipeline.stages[0].id, merged);
    for (const k of missingFields(pipeline.stages[0].requiredFields, merged)) if (!missing.includes(k)) missing.push(k);
  }
  if (missing.length) throw new ApiError(400, `Fill in ${missing.join(", ")} first.`, { needsFields: missing });
  const org = await orgOf(user, input.organisationId!).catch(() => { throw new ApiError(400, "Choose an organisation."); });
  if (org.archivedAt) throw new ApiError(400, "That organisation is archived.");
  const leader = await db.user.findUnique({ where: { id: leaderId } });
  if (!leader || !isActive(leader) || leader.workspaceId !== u.workspaceId) throw new ApiError(400, "Choose an active person as Leader.");
  const { value, currency } = normaliseValue(input.value, input.currency);
  const probability = checkProbability(input.probability);
  const classifications = classification(input);
  if (dueDate) isoDate(dueDate);
  // project-lookup-ok: Workspace-wide duplicate confirmation for the supplied name and buyer, after requireCrm; includes archived deals.
  const dup = await db.project.findFirst({
    where: { workspaceId: u.workspaceId, typeId: WORKSTREAM_DEAL, name: { equals: name, mode: "insensitive" }, parties: { some: { organisationId: org.id, role: "BUYER" } } },
    select: { id: true },
  });
  if (dup && !input.force) throw new ApiError(409, `A deal called "${name}" already exists for ${org.name}.`, { needsConfirm: "duplicate", existingId: dup.id });

  const first = pipeline!.stages[0];
  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { workspaceId: u.workspaceId, name, typeId: WORKSTREAM_DEAL, pipelineId: pipeline!.id, stageId: first.id, stageChangedAt: new Date() },
    });
    // Membership (owner decision): chosen Leader leads; the idea's assignee is an Editor; collaborators are Viewers.
    const roles = new Map<string, "LEADER" | "EDITOR" | "VIEWER">();
    roles.set(leader.id, "LEADER");
    const add = async (id: string, role: "EDITOR" | "VIEWER") => {
      if (roles.has(id)) return;
      const person = await tx.user.findUnique({ where: { id } });
      if (person && isActive(person) && person.workspaceId === u.workspaceId) roles.set(id, role);
    };
    await add(user.id, "EDITOR");
    await add(t.assigneeId, "EDITOR");
    for (const c of t.collaborators) await add(c.userId, "VIEWER");
    for (const [userId, role] of roles) await tx.projectMember.create({ data: { projectId: project.id, userId, role } });
    const sections = [];
    for (const [i, n] of DEFAULT_SECTIONS.entries()) sections.push(await tx.section.create({ data: { projectId: project.id, name: n, position: i, isDone: i === DEFAULT_SECTIONS.length - 1 } }));
    await tx.dealDetails.create({
      data: {
        projectId: project.id, workspaceId: u.workspaceId, whyPursue: why!, need: clean(input.need), serviceLine: clean(input.serviceLine), value, currency, probability, ...classifications,
        expectedClose: input.expectedClose ? isoDate(input.expectedClose) : null, introducedBy: clean(input.introducedBy),
        ...deadlinePatch(input.submissionDeadline),
      },
    });
    await tx.dealParty.create({ data: { projectId: project.id, organisationId: org.id, role: "BUYER" } });

    // Move the task and its subtasks (they keep description, assignee, collaborators, links and dates).
    const subs = await tx.task.findMany({ where: { parentId: t.id }, select: { id: true } });
    const keepApprover = t.approverId && roles.has(t.approverId) ? t.approverId : null;
    await tx.task.update({
      where: { id: t.id },
      data: { projectId: project.id, sectionId: sections[0].id, previousSectionId: null, isIdea: false, approverId: keepApprover, ...(t.dueDate ? {} : { dueDate: parseDueDate(dueDate!) }) },
    });
    if (subs.length) await tx.task.updateMany({ where: { parentId: t.id }, data: { projectId: project.id, sectionId: sections[0].id } });
    await tx.taskCollaborator.deleteMany({ where: { taskId: t.id, userId: { notIn: [...roles.keys()] } } });
    await notify(tx, [leader.id], "MADE_LEADER", { actorId: user.id, projectId: project.id, data: { project: project.name } });
    await logAction(tx, { actorId: user.id, projectId: t.projectId, targetType: "task", targetId: t.id, action: "task.moved_to_deal", primary: false, after: { dealId: project.id, deal: name, title: t.title } });
    await logAction(tx, {
      actorId: user.id, projectId: project.id, targetType: "deal", targetId: t.id, action: "deal.converted",
      before: {
        sourceProjectId: t.projectId, sectionId: t.sectionId, previousSectionId: t.previousSectionId, isIdea: t.isIdea, approverId: t.approverId,
        dueDate: t.dueDate?.toISOString() ?? null, subtaskIds: subs.map((s) => s.id),
      },
      after: { dealId: project.id, name, organisationId: org.id, pipeline: pipeline!.name, leaderId: leader.id, ...classifications, ...deadlineAudit(input.submissionDeadline) },
    });
    return project;
  });
}

/** SHO-US-12.5 AC2 and 13.1 AC3: deals the person leads that are working and have no dated open task. */
export async function dealsNeedingNextStep(user: Actor) {
  if (!crmVisible(user)) return [];
  // project-lookup-ok: crmVisible is checked first; only active deals where this user is Leader are selected.
  const deals = await db.project.findMany({
    where: { typeId: WORKSTREAM_DEAL, archivedAt: null, members: { some: { userId: user.id, role: "LEADER" } }, stage: { category: { in: [...WORKING_CATEGORIES] } } },
    select: { id: true, name: true, stage: { select: { name: true } } },
  });
  const sig = await db.task.groupBy({ by: ["projectId"], where: { projectId: { in: deals.map((d) => d.id) }, deletedAt: null, completedAt: null, parentId: null, dueDate: { not: null } }, _count: true });
  const has = new Set(sig.map((s) => s.projectId));
  return deals.filter((d) => !has.has(d.id)).map((d) => ({ id: d.id, name: d.name, stage: d.stage?.name ?? null }));
}

/**
 * Deals the stalled-deal job may name in a notice (APL-2741).
 * `crmProjectWhere` is applied for the Leader. Under `all` and unset it is empty, so the rows match
 * the previous filter. Under `off` every deal is left out. Under `admins` a deal is left out unless
 * its Leader is an Admin or the Super Admin. The role list is those two names only.
 */
export function stalledDealWhere(): Prisma.ProjectWhereInput {
  const working: Prisma.ProjectWhereInput = {
    typeId: WORKSTREAM_DEAL,
    stage: { category: { in: [...WORKING_CATEGORIES] } },
  };
  // AND keeps `archivedAt` if a later crmProjectWhere returns its own archivedAt or OR.
  const visibleTo = (role: "MEMBER" | "ADMIN" | "SUPER_ADMIN"): Prisma.ProjectWhereInput => ({
    AND: [{ archivedAt: null }, crmProjectWhere({ orgRole: role })],
  });
  const mode = crmMode();
  if (mode !== "admins") {
    // off hides deals from every role, including the Super Admin. all (and unset) hides them from nobody.
    return { AND: [working, visibleTo(mode === "off" ? "SUPER_ADMIN" : "MEMBER")] };
  }
  return {
    AND: [
      working,
      visibleTo("ADMIN"),
      // Named roles only. A future role must not receive a stalled-deal notice merely by not being a Member.
      { members: { some: { role: "LEADER", user: { orgRole: { in: ["ADMIN", "SUPER_ADMIN"] } } } } },
    ],
  };
}

/** SHO-US-12.7 AC3: one in-app notice to the Leader per stall. A new notice needs new activity first, then a new 30 days of silence. */
export async function notifyStalledDeals(now = new Date()) {
  if (crmMode() === "off") return { stalled: 0, notified: 0, skipped: true };
  const mode = crmMode();
  // project-lookup-ok: Scheduled notification job scans stalled deals; stalledDealWhere and recipient filtering enforce CRM mode.
  const deals = await db.project.findMany({
    where: stalledDealWhere(),
    include: {
      stage: true,
      members: {
        where: mode === "admins"
          ? { role: "LEADER", user: { orgRole: { in: ["ADMIN", "SUPER_ADMIN"] } } }
          : { role: "LEADER" },
        select: { userId: true, user: { select: { orgRole: true } } },
      },
    },
  });
  const signals = await dealSignals(deals);
  let stalled = 0, notified = 0;
  for (const d of deals) {
    const last = signals.get(d.id)!.lastActivity;
    if (!isStalled(d.stage?.category, last, now.getTime())) continue;
    stalled++;
    const leader = d.members[0];
    // crmVisible is the same lever as crmProjectWhere. A leader the CRM is hidden from is not told.
    if (!leader || !crmVisible(leader.user)) continue;
    const already = await db.notification.findFirst({ where: { recipientId: leader.userId, projectId: d.id, type: "DEAL_STALLED", createdAt: { gt: last } }, select: { id: true } });
    if (already) continue;
    await db.$transaction((tx) => notify(tx, [leader.userId], "DEAL_STALLED", { projectId: d.id, data: { project: d.name }, includeActor: true }));
    notified++;
  }
  return { stalled, notified };
}
