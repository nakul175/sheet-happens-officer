import { currentUser } from "@/lib/auth";
import { dealPipelines } from "@/lib/deals";
import { handle } from "@/lib/http";

export const GET = handle(async () => Response.json({ pipelines: await dealPipelines(await currentUser()) }));
