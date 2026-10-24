import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { quickAddTargets } from "@/lib/quickadd";

export const GET = handle(async () => Response.json(await quickAddTargets(await currentUser())));
