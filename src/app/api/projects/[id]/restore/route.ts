import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { restoreProject } from "@/lib/projects";
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json(await restoreProject(await currentUser(), (await ctx.params).id)),
);
