import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskMove } from "@/lib/schemas";
import { moveTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { sectionId, completeAll, expectedUpdatedAt } = await parseTaskBody(req, taskMove);
  await moveTask(me, (await ctx.params).id, sectionId, expectedUpdatedAt, completeAll);
  return Response.json({ status: "ok" });
}));
