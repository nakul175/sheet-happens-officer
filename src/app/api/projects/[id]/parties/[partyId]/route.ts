import { currentUser } from "@/lib/auth";
import { removeParty } from "@/lib/deals";
import { handle } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; partyId: string }> };
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, partyId } = await ctx.params;
  await removeParty(me, id, partyId);
  return new Response(null, { status: 204 });
});
