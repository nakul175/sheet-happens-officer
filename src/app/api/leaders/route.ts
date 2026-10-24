import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listLeaders } from "@/lib/orientation";

export const GET = handle(async () => Response.json(await listLeaders(await currentUser())));
