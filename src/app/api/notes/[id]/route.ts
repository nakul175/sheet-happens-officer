import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { removeNote } from "@/lib/records";

export const DELETE = handle(async (_r: Request, ctx: { params: Promise<{ id: string }> }) => {
  await removeNote(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
