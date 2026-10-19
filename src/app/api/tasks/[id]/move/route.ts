import { currentUser } from "@/lib/auth";
import { handle, withVersionErrors } from "@/lib/http";
import { parseVersionedBody } from "@/lib/task-version";
import { taskMove } from "@/lib/schemas";
import { assertCanUpdateTask, moveTask } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // Session, access, version, then schema (APL-2670 AC1 v1.4).
  await assertCanUpdateTask(me, (await ctx.params).id, { holderCanDo: true });
  const { sectionId, completeAll, expectedUpdatedAt } = await parseVersionedBody(req, taskMove);
  await moveTask(me, (await ctx.params).id, sectionId, expectedUpdatedAt, completeAll);
  return Response.json({ status: "ok" });
}));
