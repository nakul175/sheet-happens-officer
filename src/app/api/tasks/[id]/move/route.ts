import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskMove } from "@/lib/schemas";
import { assertTaskWritable, moveTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertTaskWritable(me, id, { holderCanDo: true });
  const { sectionId, completeAll, expectedUpdatedAt } = await parseTaskBody(req, taskMove);
  await moveTask(me, id, sectionId, expectedUpdatedAt, completeAll);
  return Response.json({ status: "ok" });
}));
