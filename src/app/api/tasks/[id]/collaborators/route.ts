import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskCollaborator } from "@/lib/schemas";
import { addCollaborator } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = await parseBody(req, taskCollaborator);
  await addCollaborator(me, (await ctx.params).id, body.userId, body.addMemberRole);
  return Response.json({ status: "ok" }, { status: 201 });
});
