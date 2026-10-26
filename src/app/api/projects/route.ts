import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createProject, listProjects } from "@/lib/projects";
import { projectCreate } from "@/lib/schemas";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const archived = new URL(req.url).searchParams.get("archived") === "true";
  return Response.json({ projects: await listProjects(me, archived, new URL(req.url).searchParams.get("deleted") === "true") });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const project = await createProject(me, await parseBody(req, projectCreate));
  return Response.json({ project: { id: project.id, name: project.name } }, { status: 201 });
});
