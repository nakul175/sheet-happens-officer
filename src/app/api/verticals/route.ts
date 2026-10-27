import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createProject, listVerticals, VERTICAL_SUGGESTIONS } from "@/lib/projects";
export const GET = handle(async () => Response.json({ verticals: await listVerticals(await currentUser()), suggestions: VERTICAL_SUGGESTIONS }));
export const POST = handle(async (req: Request) => {
  const user = await currentUser();
  const body = await parseBody(req, z.object({ name: z.string().trim().min(1).max(200) }));
  const project = await createProject(user, { name: body.name, leaderId: user.id, isVertical: true });
  return Response.json({ project: { id: project.id, name: project.name } }, { status: 201 });
});
