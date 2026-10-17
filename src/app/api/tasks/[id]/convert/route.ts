import { currentUser } from "@/lib/auth";
import { convertTaskToDeal } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { taskConvert } from "@/lib/schemas";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const p = await convertTaskToDeal(me, (await ctx.params).id, await parseBody(req, taskConvert));
  return Response.json({ deal: { id: p.id, name: p.name } }, { status: 201 });
});
