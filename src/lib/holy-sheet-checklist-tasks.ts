import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { activeMember, projectAccess, requireWrite, WORKERS, type Actor } from "@/lib/access";
import { formatDueDate, parseDueDate } from "@/lib/dates";
import { ApiError, notFound } from "@/lib/http";
import { logAction, notify } from "@/lib/notify";

const id = z.string().uuid();
export const checklistReviewInput = z.object({
  subject: z.string().min(1).max(200),
  intentId: id,
  sourcePageId: z.string().min(1).max(200),
  sourceItemId: id,
  projectId: z.string().min(1).max(200),
  assigneeId: z.string().min(1).max(200),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(240),
  sourceOrigin: z.enum(['https://holysheet.aplyd.org','https://staging.holysheet.aplyd.org']).optional(),
});
export const checklistCreateInput = z.object({ reviewToken: z.string().min(20).max(4096) });
export type ChecklistReview = z.infer<typeof checklistReviewInput>;

function reviewKey() {
  const key = process.env.SUITE_HOLY_SHEET_REVIEW_KEY;
  if (!key || key.length < 32) throw new Error("Holy Sheet review signing is not configured");
  return key;
}
function sign(value: string) { return createHmac("sha256", reviewKey()).update(value).digest("base64url"); }
function encodeReview(input: ChecklistReview) {
  const body = Buffer.from(JSON.stringify({ ...input, exp: Date.now() + 5 * 60_000 })).toString("base64url");
  return `${body}.${sign(body)}`;
}
function decodeReview(token: string): ChecklistReview {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw new ApiError(400, "Review expired. Review the destination again.");
  const expected = sign(body);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    throw new ApiError(400, "Review expired. Review the destination again.");
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new ApiError(400, "Review expired. Review the destination again."); }
  const parsed = checklistReviewInput.extend({ exp: z.number() }).safeParse(raw);
  if (!parsed.success || parsed.data.exp <= Date.now()) throw new ApiError(400, "Review expired. Review the destination again.");
  const input={...parsed.data};delete (input as {exp?:number}).exp;
  return input;
}

export async function checklistDestinations(actor: Actor) {
  // project-lookup-ok: this is the permission-filtered destination picker; native write access is rechecked for every later step.
  const projects = await db.project.findMany({
    where: {
      deletedAt: null, archivedAt: null,
      ...(actor.orgRole === "MEMBER" ? { members: { some: { userId: actor.id, role: { in: ["LEADER", "EDITOR"] } } } } : {}),
    },
    select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return { projects };
}

export async function checklistAssignees(actor: Actor, projectId: string) {
  const access = await projectAccess(actor, projectId, { write: true });
  requireWrite(access);
  const members = await db.projectMember.findMany({
    where: { projectId, role: { in: WORKERS }, user: { deactivatedAt: null, emailVerifiedAt: { not: null } } },
    select: { user: { select: { id: true, name: true } } }, orderBy: [{ user: { name: "asc" } }, { userId: "asc" }],
  });
  return { project: { id: access.project.id, name: access.project.name }, assignees: members.map((m) => m.user) };
}

export async function reviewChecklistTask(actor: Actor, subject: string, input: ChecklistReview, clientId = 'holy-sheet') {
  if (input.subject !== subject) throw new ApiError(409, "Your Aplyd account changed. Reopen the task dialog.");
  const access = await projectAccess(actor, input.projectId, { write: true });
  requireWrite(access);
  const assignee = await db.user.findUnique({ where: { id: input.assigneeId }, select: { id: true, name: true } });
  if (!assignee || !(await activeMember(db, input.projectId, input.assigneeId, WORKERS)))
    throw new ApiError(400, "The assignee must be an active Leader or Editor of this project.");
  const due = parseDueDate(input.dueDate);
  if (!Number.isFinite(due.getTime()) || formatDueDate(due) !== input.dueDate) throw new ApiError(400, "Enter a valid due date.");
  const reviewed={...input,sourceOrigin:clientId==='holy-sheet-staging'?'https://staging.holysheet.aplyd.org' as const:'https://holysheet.aplyd.org' as const};
  return {
    reviewToken: encodeReview(reviewed),
    sourceAudience: "People who can edit this Holy Sheet page",
    destinationAudience: `Members of ${access.project.name}`,
    project: { id: access.project.id, name: access.project.name }, assignee,
    dueDate: input.dueDate, title: input.title,
  };
}

export async function createChecklistTask(actor: Actor, subject: string, reviewToken: string) {
  const input = decodeReview(reviewToken);
  if (input.subject !== subject) throw new ApiError(409, "Your Aplyd account changed. Review the destination again.");
  const access = await projectAccess(actor, input.projectId, { write: true });
  requireWrite(access);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.intentId}))`;
    const prior = await tx.holySheetTaskIntent.findUnique({ where: { intentId: input.intentId } });
    if (prior) {
      if (prior.subject !== subject || prior.sourcePageId !== input.sourcePageId || prior.sourceItemId !== input.sourceItemId)
        throw new ApiError(409, "This creation intent belongs to another checklist item.");
      return { taskId: prior.taskId, created: false as const };
    }
    const project = await tx.project.findUnique({ where: { id: input.projectId }, include: { members: true } });
    const member = project?.members.find((m) => m.userId === actor.id);
    const role = actor.orgRole === "MEMBER" ? member?.role : "LEADER";
    if (!project || project.deletedAt || !role) throw notFound("Project");
    if (project.archivedAt) throw new ApiError(409, "This project is archived and read-only.");
    if (role === "VIEWER") throw new ApiError(403, "Viewers cannot make changes.");
    if (!(await activeMember(tx, input.projectId, input.assigneeId, WORKERS)))
      throw new ApiError(400, "The assignee is no longer eligible. Review the destination again.");
    const section = await tx.section.findFirst({ where: { projectId: input.projectId, isDone: false }, orderBy: { position: "asc" } });
    if (!section) throw new ApiError(409, "This project has no open section.");
    if (!input.sourceOrigin) throw new ApiError(400, "Review expired. Review the destination again.");
    const task = await tx.task.create({ data: {
      workspaceId: project.workspaceId, projectId: project.id, sectionId: section.id,
      title: input.title, description: `Holy Sheet: ${input.sourceOrigin}/pages/${input.sourcePageId}#block-${input.sourceItemId}`,
      dueDate: parseDueDate(input.dueDate), assigneeId: input.assigneeId, createdById: actor.id,
    } });
    await tx.holySheetTaskIntent.create({ data: {
      intentId: input.intentId, subject, userId: actor.id, projectId: project.id, taskId: task.id,
      sourcePageId: input.sourcePageId, sourceItemId: input.sourceItemId,
    } });
    await notify(tx, [input.assigneeId], "TASK_ASSIGNED", { actorId: actor.id, taskId: task.id, projectId: project.id, data: { title: task.title } });
    await logAction(tx, { actorId: actor.id, projectId: project.id, targetType: "task", targetId: task.id,
      action: "task.created", after: { title: task.title, assigneeId: input.assigneeId, sectionId: section.id, source: "holy-sheet", intentId: input.intentId } });
    return { taskId: task.id, created: true as const };
  });
}

export async function checklistTaskReceipt(actor: Actor, subject: string, intentId: string) {
  const intent = await db.holySheetTaskIntent.findUnique({ where: { intentId } });
  if (!intent || intent.subject !== subject || intent.userId !== actor.id) throw notFound("Task link");
  await projectAccess(actor, intent.projectId);
  return { taskId: intent.taskId, projectId: intent.projectId };
}
