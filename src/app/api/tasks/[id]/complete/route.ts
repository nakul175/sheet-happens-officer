import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskComplete } from "@/lib/schemas";
import { completeTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, taskComplete);
  await completeTask(me, (await ctx.params).id, (body as { completeAll?: boolean }).completeAll);
  return Response.json({ status: "ok" });
});
