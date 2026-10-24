import type { Prisma } from '@/generated/prisma/client';
import { ApiError } from '@/lib/http';

// Owner decision: Submitted, Won and Ongoing Projects only. No-Go, On Hold,
// Lost and draft stages do not imply that a submission actually happened.
const SUBMISSION_STAGES = new Set(['st_bid_submitted', 'st_bid_won', 'st_bid_ongoing']);
const REQUIRED = ['netFeeRevenueUsd', 'probability', 'athenaEntity'] as const;
const LABELS = { netFeeRevenueUsd: 'NFR (USD)', probability: 'PWin', athenaEntity: 'Athena Entity' };
export function assertBidSubmissionFields(key: string | null, stageId: string | null, fields: Record<string, unknown>) {
  if (key !== 'DEAL_BID' || !stageId || !SUBMISSION_STAGES.has(stageId)) return;
  const missing = REQUIRED.filter(k => fields[k] == null || fields[k] === '');
  if (missing.length) throw new ApiError(409, `Fill in ${missing.map(k => LABELS[k]).join(', ')} before saving a submitted Bid.`, { needsFields: missing });
}

/** Serialize stage/detail writers on the same project; re-read fields only after
 * acquiring the lock, so a concurrent null-clear cannot race a submission. */
export async function guardBidSubmissionWrite(tx: Prisma.TransactionClient, projectId: string, patch: Record<string, unknown>, targetStage?: string, expectedPipeline?: string | null) {
  const rows = await tx.$queryRaw<{ pipelineId: string | null; stageId: string | null; key: string | null }[]>`
    SELECT p."pipelineId", p."stageId", pipeline.key
    FROM "Project" p LEFT JOIN "Pipeline" pipeline ON pipeline.id=p."pipelineId"
    WHERE p.id=${projectId} FOR UPDATE OF p`;
  const project = rows[0];
  if (!project || (expectedPipeline !== undefined && project.pipelineId !== expectedPipeline)) throw new ApiError(409, 'The deal changed. Refresh before saving.');
  const details = await tx.dealDetails.findUnique({ where: { projectId } });
  if (!details) throw new ApiError(409, 'The deal details no longer exist.');
  const effective = { ...details, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  assertBidSubmissionFields(project.key, targetStage ?? project.stageId, effective);
  return details;
}
