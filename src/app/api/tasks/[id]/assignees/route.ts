import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { handle, notFound, parseBody } from "@/lib/http";
import { assigneeSet } from "@/lib/schemas";
import { assertAssignees, taskInclude } from "@/lib/tasks";

// Replace the full assignee set for a task.
export const PUT = handle(async (req: NextRequest, ctx: RouteContext<"/api/tasks/[id]/assignees">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  const existing = await db.task.findFirst({ where: { id, workspaceId: me.workspaceId } });
  if (!existing) throw notFound("Task");

  const { userIds } = await parseBody(req, assigneeSet);
  const unique = [...new Set(userIds)];
  await assertAssignees(me.workspaceId, unique);

  const task = await db.$transaction(async (tx) => {
    await tx.taskAssignee.deleteMany({ where: { taskId: id, userId: { notIn: unique } } });
    await tx.taskAssignee.createMany({
      data: unique.map((userId) => ({ taskId: id, userId })),
      skipDuplicates: true,
    });
    return tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
  });
  return Response.json({ task });
});
