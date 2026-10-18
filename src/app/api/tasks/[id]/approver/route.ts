import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskApprover } from "@/lib/schemas";
import { setApprover } from "@/lib/tasks";

export const PUT = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = await parseTaskBody(req, taskApprover);
  await setApprover(me, (await ctx.params).id, body.approverId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
}));
