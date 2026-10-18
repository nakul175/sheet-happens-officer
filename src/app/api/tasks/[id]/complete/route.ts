import { currentUser } from "@/lib/auth";
import { handle, parseBody, withVersionErrors } from "@/lib/http";
import { taskComplete } from "@/lib/schemas";
import { completeTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = await parseBody(req, taskComplete);
  await completeTask(me, (await ctx.params).id, body.expectedUpdatedAt, body.completeAll);
  return Response.json({ status: "ok" });
}));
