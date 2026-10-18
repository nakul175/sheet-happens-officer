import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listNotifications } from "@/lib/feed";

// ?filter=unread&before=<next>&limit=50
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  return Response.json(await listNotifications(await currentUser(), {
    filter: q.get("filter") ?? undefined,
    before: q.get("before") ?? undefined,
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
  }));
});
