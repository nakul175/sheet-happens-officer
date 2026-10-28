import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { pipelineReview } from "@/lib/review";
import { requestNow } from "@/lib/test-clock";

export const GET = handle(async (req: Request) => Response.json(await pipelineReview(await currentUser(), requestNow(req))));
