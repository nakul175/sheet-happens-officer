import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { getProject, updateProject } from "@/lib/projects";
import { projectUpdate } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ project: await getProject(await currentUser(), (await ctx.params).id) }),
);

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  await updateProject(me, (await ctx.params).id, await parseBody(req, projectUpdate));
  return Response.json({ status: "ok" });
});
