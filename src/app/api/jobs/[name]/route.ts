import { handle } from "@/lib/http";
import { requireJobSecret, runJob } from "@/lib/jobs";
import { requestNow } from "@/lib/test-clock";

// Called by the server's cron with the JOB_SECRET (SHO-US-9.3). Not reachable by signed-in people.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ name: string }> }) => {
  requireJobSecret(req);
  return Response.json(await runJob((await ctx.params).name, new Date(requestNow(req))));
});
