import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { ApiError, handle, notFound, parseBody } from "@/lib/http";
import { taskUpdate } from "@/lib/schemas";
import { positionBetween, taskInclude } from "@/lib/tasks";

async function load(id: string, workspaceId: string) {
  const task = await db.task.findFirst({ where: { id, workspaceId }, include: taskInclude });
  if (!task) throw notFound("Task");
  return task;
}

export const GET = handle(async (_req: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  const task = await load(id, me.workspaceId);
  const subtasks = await db.task.findMany({
    where: { parentId: id },
    include: taskInclude,
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return Response.json({ task, subtasks });
});

export const PATCH = handle(async (req: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  const existing = await load(id, me.workspaceId);
  const input = await parseBody(req, taskUpdate);

  if (input.projectId && existing.parentId) {
    throw new ApiError(400, "A subtask moves with its parent; move the parent instead");
  }
  if (input.projectId && input.projectId !== existing.projectId) {
    const target = await db.project.findFirst({ where: { id: input.projectId, workspaceId: me.workspaceId } });
    if (!target) throw notFound("Project");
  }

  const projectId = input.projectId ?? existing.projectId;
  const status = input.status ?? existing.status;
  const columnChanged = projectId !== existing.projectId || status !== existing.status;
  const reorder = input.beforeId !== undefined || input.afterId !== undefined;

  let position: number | undefined;
  if (reorder || columnChanged) {
    position = await positionBetween(
      me.workspaceId,
      projectId,
      status,
      existing.parentId,
      input.beforeId,
      input.afterId,
    );
  }

  const completedAt =
    input.status === undefined || input.status === existing.status
      ? undefined
      : input.status === "DONE"
        ? new Date()
        : null;

  const task = await db.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate,
        projectId: input.projectId,
        position,
        completedAt,
      },
      include: taskInclude,
    });
    if (input.projectId && input.projectId !== existing.projectId) {
      await tx.task.updateMany({ where: { parentId: id }, data: { projectId: input.projectId } });
    }
    return updated;
  });
  return Response.json({ task });
});

// Deleting a task cascades to its subtasks.
export const DELETE = handle(async (_req: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  await load(id, me.workspaceId);
  await db.task.delete({ where: { id } });
  return new Response(null, { status: 204 });
});
