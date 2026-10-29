import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { pipelineReview, REVIEW_TIMELINES, type ReviewTimeline } from "@/lib/review";
import { requestNow } from "@/lib/test-clock";

export const GET = handle(async (req: Request) => {
  const requested = new URL(req.url).searchParams.get("timeline") ?? "all";
  const timeline: ReviewTimeline = REVIEW_TIMELINES.includes(requested as ReviewTimeline) ? requested as ReviewTimeline : "all";
  return Response.json(await pipelineReview(await currentUser(), timeline, requestNow(req)));
});
