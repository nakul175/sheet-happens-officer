import { currentUser } from "@/lib/auth";
import { ApiError, handle } from "@/lib/http";
import { workspaceTaskPeople } from "@/lib/project-task-membership";
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const query = new URL(req.url).searchParams;
  const purpose = query.get("purpose") ?? "assignee";
  if (purpose !== "assignee" && purpose !== "collaborator") throw new ApiError(400, "Choose assignee or collaborator search.");
  return Response.json({ people: await workspaceTaskPeople(await currentUser(), (await ctx.params).id, (query.get("q") ?? "").slice(0, 100), purpose) });
});
