import { z } from "zod";
import { db } from "@/lib/db";
import { isAdmin, projectAccess, requireManage, type Actor } from "@/lib/access";
import { requireCrm, WORKSTREAM_DEAL } from "@/lib/crm";
import { ApiError, notFound } from "@/lib/http";
import { logAction } from "@/lib/notify";
import { parseSubmissionDeadline, serializeSubmissionDeadline } from "@/lib/submission-deadline";

export const proactiveToBidInput = z.object({
  expectedPipelineId: z.string().min(1), expectedStageId: z.string().min(1),
  confirmed: z.literal(true),
  submissionDeadline: z.string().max(40).refine((value) => { try { return !!parseSubmissionDeadline(value).deadline; } catch { return false; } }, "Choose a valid submission date, with an optional time and timezone."),
});
const OPEN_SOURCE = ["NOT_STARTED", "ACTIVE", "PAUSED"];

/** An explicit business transition on the same deal; never mutate either pipeline's configuration. */
export async function convertProactiveToBid(user: Actor, projectId: string, raw: z.infer<typeof proactiveToBidInput>) {
  requireCrm(user);
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  if (a.project.typeId !== WORKSTREAM_DEAL) throw new ApiError(400, "Only Proactive deals can be converted to Bid.");
  const checked = proactiveToBidInput.safeParse(raw);
  if (!checked.success) throw new ApiError(400, "Confirm conversion and choose a valid submission deadline.");
  const input = checked.data, parsed = parseSubmissionDeadline(input.submissionDeadline);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id: projectId }, include: { members: true } });
    if (!project || project.typeId !== WORKSTREAM_DEAL) throw notFound("Deal");
    const member = project.members.find((m) => m.userId === user.id);
    if (!member && !isAdmin(user)) throw notFound("Project");
    if (!isAdmin(user) && member?.role !== "LEADER") throw new ApiError(403, "Only the project Leader or an Admin can do this.");
    if (project.archivedAt) throw new ApiError(409, "This project is archived and read-only.");
    if (project.pipelineId !== input.expectedPipelineId || project.stageId !== input.expectedStageId) throw new ApiError(409, "The deal's pipeline or stage changed. Refresh before converting.");
    const source = await tx.pipeline.findFirst({ where: { id: project.pipelineId!, key: "DEAL_PROACTIVE", typeId: WORKSTREAM_DEAL } });
    if (!source) throw new ApiError(409, "Only an open Proactive deal can be converted to Bid.");
    const sourceStage = await tx.stage.findFirst({ where: { id: project.stageId!, pipelineId: source.id, isRetired: false } });
    if (!sourceStage || !OPEN_SOURCE.includes(sourceStage.category)) throw new ApiError(409, "Won, Lost, retired or delivery deals cannot be converted to Bid.");
    const bid = await tx.pipeline.findFirst({ where: { key: "DEAL_BID", typeId: WORKSTREAM_DEAL } });
    if (!bid) throw new ApiError(409, "The Bid pipeline is not available. Ask an Admin to inspect its configuration.");
    // Retain exact stage semantics; do not silently reinterpret a customized installation.
    const leads = await tx.stage.findFirst({ where: { id: "st_bid_identified", pipelineId: bid.id, name: "Leads", isRetired: false, category: "ACTIVE", needsReason: false, requiredFields: { isEmpty: true } } });
    if (!leads) throw new ApiError(409, "The neutral Bid Leads stage is not available. Ask an Admin to inspect its configuration.");
    const details = await tx.dealDetails.findUnique({ where: { projectId } });
    if (!details) throw new ApiError(409, "This deal has no details. Ask an Admin to inspect it.");
    await tx.dealDetails.update({ where: { projectId }, data: { submissionDeadline: parsed.deadline, submissionDeadlineHasTime: parsed.hasTime } });
    await tx.project.update({ where: { id: projectId }, data: { pipelineId: bid.id, stageId: leads.id, stageReason: null, stageChangedAt: new Date() } });
    await logAction(tx, {
      actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.pipeline_converted",
      before: { pipelineId: source.id, pipeline: source.name, stageId: sourceStage.id, stage: sourceStage.name, stageReason: project.stageReason, stageChangedAt: project.stageChangedAt?.toISOString() ?? null, submissionDeadline: serializeSubmissionDeadline(details.submissionDeadline, details.submissionDeadlineHasTime), submissionDeadlineHasTime: details.submissionDeadlineHasTime },
      after: { pipelineId: bid.id, pipeline: bid.name, stageId: leads.id, stage: leads.name, stageReason: null, submissionDeadline: serializeSubmissionDeadline(parsed.deadline, parsed.hasTime), submissionDeadlineHasTime: parsed.hasTime },
      primary: false, // No conversion Undo is advertised; the historical audit remains intact.
    });
    return { pipelineId: bid.id, stageId: leads.id };
  });
}
