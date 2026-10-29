import { currentUser } from "@/lib/auth";
import { updateDealDetails } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealDetailsEdit } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  await updateDealDetails(me, (await ctx.params).id, await parseBody(req, dealDetailsEdit));
  return Response.json({ status: "ok" });
});
