import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskApprover } from "@/lib/schemas";
import { setApprover } from "@/lib/tasks";

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  await setApprover(me, (await ctx.params).id, (await parseBody(req, taskApprover)).approverId);
  return Response.json({ status: "ok" });
});
