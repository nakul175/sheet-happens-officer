import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { markRead } from "@/lib/feed";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await markRead(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
