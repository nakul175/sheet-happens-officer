import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { unarchiveProject } from "@/lib/projects";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await unarchiveProject(await currentUser(), (await ctx.params).id);
  return Response.json({ status: "ok" });
});
