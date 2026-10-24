import { currentUser } from "@/lib/auth";
import { handle, withVersionErrors } from "@/lib/http";
import { parseVersionedBody } from "@/lib/task-version";
import { taskApprover } from "@/lib/schemas";
import { assertCanUpdateTask, setApprover } from "@/lib/tasks";

export const PUT = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // Session, access, version, then schema (APL-2670 AC1 v1.4).
  await assertCanUpdateTask(me, (await ctx.params).id);
  const body = await parseVersionedBody(req, taskApprover);
  await setApprover(me, (await ctx.params).id, body.approverId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
}));
