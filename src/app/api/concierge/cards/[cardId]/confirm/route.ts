import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergeConfirm } from "@/lib/schemas";
import { confirmCard } from "@/lib/concierge/cards";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ cardId: string }> }) => {
  const me = await currentUser();
  const body = await req.text();
  const parsed = body.trim() ? await parseBody(new Request(req.url, { method: "POST", body }), conciergeConfirm) : {};
  return Response.json(await confirmCard(me, (await ctx.params).cardId, parsed.handover, parsed.acknowledge));
});
