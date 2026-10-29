import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { assertScreenViewEditable, deleteScreenView, saveScreenView, screenViewInput } from "@/lib/screen-views";
type Context = { params: Promise<{ id: string }> };
export const PATCH = handle(async (req: Request, ctx: Context) => {
  const user = await currentUser(), { id } = await ctx.params;
  await assertScreenViewEditable(user, id);
  return Response.json({ view: await saveScreenView(user, await parseBody(req, screenViewInput), id) });
});
export const DELETE = handle(async (req: Request, ctx: Context) => {
  await deleteScreenView(await currentUser(), (await ctx.params).id, new URL(req.url).searchParams.get("confirmShared") === "true");
  return new Response(null, { status: 204 });
});
