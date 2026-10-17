import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskReopen } from "@/lib/schemas";
import { reopenTask } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, taskReopen);
  await reopenTask(me, (await ctx.params).id, (body as { sectionId?: string }).sectionId);
  return Response.json({ status: "ok" });
});
