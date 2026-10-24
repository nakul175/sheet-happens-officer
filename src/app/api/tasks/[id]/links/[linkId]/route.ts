import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { removeTaskLink } from "@/lib/records";

export const DELETE = handle(async (_r: Request, ctx: { params: Promise<{ id: string; linkId: string }> }) => {
  const { id, linkId } = await ctx.params;
  await removeTaskLink(await currentUser(), id, linkId);
  return new Response(null, { status: 204 });
});
