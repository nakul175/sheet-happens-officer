import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listSessions } from "@/lib/feed";

export const GET = handle(async () => Response.json({ sessions: await listSessions(await currentUser()) }));
