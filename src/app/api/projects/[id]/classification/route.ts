import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { classifyProject } from "@/lib/projects";
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await currentUser();
  const body = await parseBody(req, z.object({ isVertical: z.boolean() }));
  await classifyProject(user, (await ctx.params).id, body.isVertical);
  return Response.json({ status: "ok" });
});
