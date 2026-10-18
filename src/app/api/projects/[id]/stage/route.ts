import { currentUser } from "@/lib/auth";
import { closingTasks, moveStage } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealStage } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** Open tasks that would refuse a move to Won or Lost. Does not change the deal. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  return Response.json(await closingTasks(await currentUser(), (await ctx.params).id));
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const r = await moveStage(me, (await ctx.params).id, await parseBody(req, dealStage));
  return Response.json({ stage: { id: r.stage.id, name: r.stage.name } });
});
