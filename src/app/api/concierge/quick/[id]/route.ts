import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { quickAction } from "@/lib/concierge/engine";

// Optional body { projectId } scopes the answer to one project (SHO-US-14.15).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const body = (await req.json().catch(() => ({}))) as { projectId?: unknown };
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined;
  return Response.json(await quickAction(await currentUser(), (await ctx.params).id, new Date(), projectId));
});
