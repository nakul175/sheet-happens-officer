import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskCollaborator } from "@/lib/schemas";
import { addCollaborator, assertCanUpdateTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertCanUpdateTask(me, id);
  const body = await parseBody(req, taskCollaborator);
  await addCollaborator(me, id, body.userId, { addToProject: body.addToProject, expectedUpdatedAt: body.expectedUpdatedAt });
  return Response.json({ status: "ok" }, { status: 201 });
});
