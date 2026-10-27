import { currentUser } from "@/lib/auth";
import { handle, notFound, parseQuery } from "@/lib/http";
import { workloadAvailable, workloadEnabled, workloadSummary, workloadTasks } from "@/lib/workload";
import { workloadMetric, workloadQuery } from "@/lib/workload-query";

export const GET = handle(async (req: Request) => {
  if (!workloadEnabled()) throw notFound("Workload");
  const user = await currentUser();
  if (!await workloadAvailable(user)) throw notFound("Workload");
  const q = parseQuery(new URL(req.url), workloadQuery);
  return Response.json(q.assignee ? await workloadTasks(user, q.assignee, workloadMetric(q), q.cursor) : await workloadSummary(user));
});
