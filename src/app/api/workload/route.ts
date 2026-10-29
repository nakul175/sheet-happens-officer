import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { workload } from "@/lib/workload";
export const GET = handle(async (request: Request) => Response.json(await workload(await currentUser(), new URL(request.url).searchParams)));
