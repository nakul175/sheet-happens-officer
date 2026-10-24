import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { pipelineReview } from "@/lib/review";

export const GET = handle(async () => Response.json(await pipelineReview(await currentUser())));
