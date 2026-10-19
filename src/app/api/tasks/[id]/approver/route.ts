import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskApprover } from "@/lib/schemas";
import { assertTaskWritable, setApprover } from "@/lib/tasks";

export const PUT = handle(withVersionErrors(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertTaskWritable(me, id);
  const body = await parseTaskBody(req, taskApprover);
  await setApprover(me, id, body.approverId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
}));
