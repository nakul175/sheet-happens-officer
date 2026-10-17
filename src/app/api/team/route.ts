import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listTeam } from "@/lib/team";

export const GET = handle(async () => Response.json({ people: await listTeam(await currentUser()) }));
