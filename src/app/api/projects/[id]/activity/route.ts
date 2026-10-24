import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { projectActivity } from "@/lib/feed";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
  return Response.json(await projectActivity(await currentUser(), (await ctx.params).id, cursor));
});
