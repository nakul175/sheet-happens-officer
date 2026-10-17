import { currentUser } from "@/lib/auth";
import { addParty } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealParty } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const b = await parseBody(req, dealParty);
  await addParty(me, (await ctx.params).id, b.organisationId, b.role);
  return Response.json({ ok: true }, { status: 201 });
});
