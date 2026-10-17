import { currentUser } from "@/lib/auth";
import { moveStage } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealStage } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const r = await moveStage(me, (await ctx.params).id, await parseBody(req, dealStage));
  return Response.json({ stage: { id: r.stage.id, name: r.stage.name } });
});
