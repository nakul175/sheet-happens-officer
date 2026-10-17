import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskAssign } from "@/lib/schemas";
import { assignTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  await assignTask(me, (await ctx.params).id, (await parseBody(req, taskAssign)).assigneeId);
  return Response.json({ status: "ok" });
});
