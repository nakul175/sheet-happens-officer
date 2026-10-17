import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { changeLeader } from "@/lib/projects";
import { leaderChange } from "@/lib/schemas";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  await changeLeader(me, (await ctx.params).id, await parseBody(req, leaderChange));
  return Response.json({ status: "ok" });
});
