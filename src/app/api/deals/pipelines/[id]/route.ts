import { currentUser } from "@/lib/auth";
import { removeStage } from "@/lib/deals";
import { handle } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// SHO-US-10.2 AC3. The id is a stage of a deal pipeline. ?moveTo=<stage id> says where its items go;
// without it the answer is 409 and asks.
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const moveTo = new URL(req.url).searchParams.get("moveTo");
  return Response.json(await removeStage(me, (await ctx.params).id, { moveTo }));
});
