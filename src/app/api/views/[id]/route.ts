import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { deleteView, ownView, renameView, viewRename } from "@/lib/views";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  await ownView(me, (await ctx.params).id); // before the body, so someone else's view is 404, not 400 (APL-2651)
  return Response.json({ view: await renameView(me, (await ctx.params).id, (await parseBody(req, viewRename)).name) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteView(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
