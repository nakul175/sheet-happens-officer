import { currentUser } from "@/lib/auth";
import { handle, withVersionErrors } from "@/lib/http";
import { parseVersionedBody } from "@/lib/task-version";
import { taskAssign } from "@/lib/schemas";
import { assignTask, checkAssign } from "@/lib/tasks";

export const POST = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // APL-2714: access before the body. APL-2875: through loadTask, so an outsider gets the missing-id answer.
  await checkAssign(me, (await ctx.params).id);
  // Version before schema (APL-2670 AC1 v1.4).
  const body = await parseVersionedBody(req, taskAssign);
  await assignTask(me, (await ctx.params).id, body.assigneeId, body.expectedUpdatedAt, body.addMemberRole);
  return Response.json({ status: "ok" });
}));
