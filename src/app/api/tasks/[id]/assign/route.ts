import { currentUser } from "@/lib/auth";
import { handle, parseBody, withVersionErrors } from "@/lib/http";
import { taskAssign } from "@/lib/schemas";
import { assignTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = await parseBody(req, taskAssign);
  await assignTask(me, (await ctx.params).id, body.assigneeId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
}));
