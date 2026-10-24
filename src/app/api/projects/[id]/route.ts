import { projectAccess, requireManage } from "@/lib/access";
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
  const id = (await ctx.params).id;
  // APL-2714: the same access answer updateProject gives, before the body is read.
  requireManage(await projectAccess(me, id, { write: true }));
  await updateProject(me, id, await parseBody(req, projectUpdate));
  return Response.json({ status: "ok" });
});
