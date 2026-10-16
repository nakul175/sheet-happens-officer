import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { handle, notFound, parseBody } from "@/lib/http";
import { projectUpdate } from "@/lib/schemas";

async function load(id: string, workspaceId: string) {
  const project = await db.project.findFirst({ where: { id, workspaceId } });
  if (!project) throw notFound("Project");
  return project;
}

export const GET = handle(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  return Response.json({ project: await load(id, me.workspaceId) });
});

export const PATCH = handle(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  await load(id, me.workspaceId);
  const input = await parseBody(req, projectUpdate);
  const project = await db.project.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
    },
  });
  return Response.json({ project });
});

// Deleting a project cascades to its tasks. Prefer PATCH {archived:true} for reversible removal.
export const DELETE = handle(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) => {
  const me = await currentUser();
  const { id } = await ctx.params;
  await load(id, me.workspaceId);
  await db.project.delete({ where: { id } });
  return new Response(null, { status: 204 });
});
