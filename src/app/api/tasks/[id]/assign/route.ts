import { requireWrite } from "@/lib/access";
import { db } from "@/lib/db";
import { notFound } from "@/lib/http";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskAssign } from "@/lib/schemas";
import { assignTask, taskAccess } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // APL-2714: the not-found and write answers assignTask gives, before the body is read.
  const t = await db.task.findUnique({ where: { id: (await ctx.params).id }, select: { projectId: true, deletedAt: true } });
  if (!t || t.deletedAt) throw notFound("Task");
  // APL-2875: an outsider gets the same "Task not found" as a missing id.
  requireWrite(await taskAccess(me, t.projectId, { write: true }));
  const body = await parseBody(req, taskAssign);
  await assignTask(me, (await ctx.params).id, body.assigneeId, body.expectedUpdatedAt);
  return Response.json({ status: "ok" });
});
