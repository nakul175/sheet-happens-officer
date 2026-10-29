import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { deleteProject } from "@/lib/projects";
import { z } from "zod";
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const body = await parseBody(req, z.object({ confirmationName: z.string().min(1) }));
  return Response.json(await deleteProject(me, (await ctx.params).id, body.confirmationName));
});
