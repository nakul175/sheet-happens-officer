import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskComplete } from "@/lib/schemas";
import { assertTaskWritable, completeTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertTaskWritable(me, id, { holderCanDo: true });
  const body = await parseTaskBody(req, taskComplete);
  await completeTask(me, id, body.expectedUpdatedAt, body.completeAll);
  return Response.json({ status: "ok" });
}));
