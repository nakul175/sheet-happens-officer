import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskRestore } from "@/lib/schemas";
import { restoreTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, taskRestore);
  await restoreTask(me, (await ctx.params).id, (body as { confirmParent?: boolean }).confirmParent);
  return Response.json({ status: "ok" });
});
