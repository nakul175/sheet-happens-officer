import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { archiveProject } from "@/lib/projects";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json(await archiveProject(await currentUser(), (await ctx.params).id)),
);
