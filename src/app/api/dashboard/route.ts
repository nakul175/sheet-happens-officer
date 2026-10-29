import { currentUser } from "@/lib/auth";
import { handle, ApiError } from "@/lib/http";
import { dashboardTasks, dashboardProjects, dashboardActivity, dashboardApprovals } from "@/lib/dashboard";
export const GET = handle(async (req: Request) => {
  const user = await currentUser();
  const q = new URL(req.url).searchParams;
  const panel = q.get("panel") ?? "tasks";
  const cursor = q.get("cursor") ?? undefined;
  if (cursor && cursor.length > 200) throw new ApiError(400, "Invalid cursor.");
  const result = panel === "tasks" ? await dashboardTasks(user) : panel === "projects" ? await dashboardProjects(user) : panel === "activity" ? await dashboardActivity(user) : panel === "approvals" ? await dashboardApprovals(user, cursor) : null;
  if (!result) throw new ApiError(400, "Unknown dashboard panel.");
  return Response.json(result, { headers: { "cache-control": "private, no-store" } });
});
