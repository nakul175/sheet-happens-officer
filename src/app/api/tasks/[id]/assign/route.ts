import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskAssign } from "@/lib/schemas";
import { assertTaskWritable, assignTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertTaskWritable(me, id);
  const body = await parseTaskBody(req, taskAssign);
  await assignTask(me, id, body.assigneeId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
}));
