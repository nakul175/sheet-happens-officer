import { currentUser } from "@/lib/auth";
import { convertToBid, previewBidConversion } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealBidConversion } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const preview = await previewBidConversion(await currentUser(), (await ctx.params).id);
  return Response.json(preview);
});
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const deal = await convertToBid(await currentUser(), (await ctx.params).id, await parseBody(req, dealBidConversion));
  return Response.json({ deal });
});
