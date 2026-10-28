import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { pipelineReview } from "@/lib/review";

import { filtersFromQuery } from "@/lib/screen-view-state";
export const GET = handle(async (req: Request) => Response.json(await pipelineReview(await currentUser(), filtersFromQuery(new URL(req.url).searchParams))));
