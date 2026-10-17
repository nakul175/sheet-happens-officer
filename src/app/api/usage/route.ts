import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { usageSummary } from "@/lib/usage";

export const GET = handle(async () => Response.json(await usageSummary(await currentUser())));
