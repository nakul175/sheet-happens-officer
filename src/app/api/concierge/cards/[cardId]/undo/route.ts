import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergeUndo } from "@/lib/schemas";
import { undoCard } from "@/lib/concierge/cards";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ cardId: string }> }) => {
  const me = await currentUser();
  const body = await req.text();
  const parsed = body.trim() ? await parseBody(new Request(req.url, { method: "POST", body }), conciergeUndo) : {};
  return Response.json(await undoCard(me, (await ctx.params).cardId, parsed.anyway));
});
