import { currentUser } from "@/lib/auth";
import { dealBuyerReplacement, replaceDealBuyer } from "@/lib/deal-buyer";
import { handle, parseBody } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const result = await replaceDealBuyer(me, (await ctx.params).id, await parseBody(req, dealBuyerReplacement));
  return Response.json({ status: "ok", ...result });
});
