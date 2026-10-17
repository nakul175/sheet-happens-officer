import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { reactivate } from "@/lib/team";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await reactivate(await currentUser(), (await ctx.params).id);
  return Response.json({ status: "ok" });
});
