import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskAssign } from "@/lib/schemas";
import { assignTask, checkAssign } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // APL-2714: access before the body. APL-2875: through loadTask, so an outsider gets the missing-id answer.
  await checkAssign(me, (await ctx.params).id);
  const body = await parseBody(req, taskAssign);
  await assignTask(me, (await ctx.params).id, body.assigneeId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
});
