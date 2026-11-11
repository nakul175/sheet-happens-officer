import { currentUser } from "@/lib/auth";
import { replaceBuyer } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealBuyerReplace } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const result = await replaceBuyer(me, (await ctx.params).id, await parseBody(req, dealBuyerReplace));
  return Response.json(result);
});
