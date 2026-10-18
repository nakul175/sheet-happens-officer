import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createView, listViews, viewCreate } from "@/lib/views";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => Response.json(await listViews(await currentUser(), (await ctx.params).id)));

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  return Response.json({ view: await createView(me, (await ctx.params).id, await parseBody(req, viewCreate)) }, { status: 201 });
});
