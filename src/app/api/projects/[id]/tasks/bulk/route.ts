import { currentUser } from "@/lib/auth";
import { bulkChange, bulkInput } from "@/lib/bulk";
import { handle, parseBody } from "@/lib/http";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  return Response.json(await bulkChange(me, (await ctx.params).id, await parseBody(req, bulkInput)));
});
