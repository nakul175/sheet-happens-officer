import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { projectCreate } from "@/lib/schemas";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const includeArchived = new URL(req.url).searchParams.get("archived") === "true";
  const projects = await db.project.findMany({
    where: { workspaceId: me.workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { tasks: { where: { parentId: null } } } } },
  });
  return Response.json({ projects });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const input = await parseBody(req, projectCreate);
  const project = await db.project.create({
    data: { workspaceId: me.workspaceId, name: input.name, description: input.description ?? null },
  });
  return Response.json({ project }, { status: 201 });
});
