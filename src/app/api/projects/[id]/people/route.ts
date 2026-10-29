import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { searchWorkspacePeople } from "@/lib/projects";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json(await searchWorkspacePeople(me, (await ctx.params).id, q));
});
