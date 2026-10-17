import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { removeCollaborator } from "@/lib/tasks";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string; userId: string }> }) => {
  const { id, userId } = await ctx.params;
  await removeCollaborator(await currentUser(), id, userId);
  return new Response(null, { status: 204 });
});
