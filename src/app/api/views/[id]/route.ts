import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { assertOwnView, deleteView, renameView, viewRename } from "@/lib/views";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertOwnView(me, id);
  const { name } = await parseBody(req, viewRename);
  return Response.json({ view: await renameView(me, id, name) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteView(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
