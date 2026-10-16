import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { ApiError, handle, notFound, parseBody, parseQuery } from "@/lib/http";
import { taskCreate, taskQuery } from "@/lib/schemas";
import { assertAssignees, endPosition, taskInclude } from "@/lib/tasks";
import type { Prisma } from "@/generated/prisma/client";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const q = parseQuery(new URL(req.url), taskQuery);

  const where: Prisma.TaskWhereInput = {
    workspaceId: me.workspaceId,
    projectId: q.projectId,
    status: q.status,
    parentId: q.parentId ?? (q.topLevel === "true" ? null : undefined),
    ...(q.topLevel === "false" && !q.parentId ? { parentId: { not: null } } : {}),
    ...(q.assigneeId ? { assignees: { some: { userId: q.assigneeId } } } : {}),
    ...(q.dueBefore ? { dueDate: { lte: q.dueBefore } } : {}),
    ...(q.q ? { title: { contains: q.q, mode: "insensitive" as const } } : {}),
  };

  const rows = await db.task.findMany({
    where,
    include: taskInclude,
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > q.limit;
  const tasks = hasMore ? rows.slice(0, q.limit) : rows;
  return Response.json({ tasks, nextCursor: hasMore ? tasks[tasks.length - 1].id : null });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const input = await parseBody(req, taskCreate);

  let projectId = input.projectId;
  if (input.parentId) {
    const parent = await db.task.findFirst({ where: { id: input.parentId, workspaceId: me.workspaceId } });
    if (!parent) throw notFound("Parent task");
    if (parent.parentId) throw new ApiError(400, "Subtasks can only be one level deep");
    projectId = parent.projectId; // subtasks always live in their parent's project
  }

  const project = await db.project.findFirst({ where: { id: projectId, workspaceId: me.workspaceId } });
  if (!project) throw notFound("Project");

  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  await assertAssignees(me.workspaceId, assigneeIds);

  const status = input.status ?? "TODO";
  const task = await db.task.create({
    data: {
      workspaceId: me.workspaceId,
      projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority ?? "MEDIUM",
      dueDate: input.dueDate ?? null,
      position: await endPosition(projectId, status, input.parentId ?? null),
      completedAt: status === "DONE" ? new Date() : null,
      createdById: me.id,
      assignees: { create: assigneeIds.map((userId) => ({ userId })) },
    },
    include: taskInclude,
  });
  return Response.json({ task }, { status: 201 });
});
