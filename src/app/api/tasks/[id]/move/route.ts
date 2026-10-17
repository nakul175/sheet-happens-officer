import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskMove } from "@/lib/schemas";
import { moveTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { sectionId, completeAll } = await parseBody(req, taskMove);
  await moveTask(me, (await ctx.params).id, sectionId, completeAll);
  return Response.json({ status: "ok" });
});
