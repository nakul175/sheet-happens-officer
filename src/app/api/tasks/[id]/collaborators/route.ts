import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskCollaborator } from "@/lib/schemas";
import { addCollaborator } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  await addCollaborator(me, (await ctx.params).id, (await parseBody(req, taskCollaborator)).userId);
  return Response.json({ status: "ok" }, { status: 201 });
});
