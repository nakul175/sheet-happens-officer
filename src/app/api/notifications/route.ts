import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listNotifications } from "@/lib/feed";

export const GET = handle(async () => Response.json(await listNotifications(await currentUser())));
