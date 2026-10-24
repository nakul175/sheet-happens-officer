import { currentUser } from "@/lib/auth";
import { ApiError, handle } from "@/lib/http";
import { jobStatus } from "@/lib/jobs";

// Last run of each scheduled job, for the Super Admin (SHO-US-9.3 AC6).
export const GET = handle(async () => {
  const me = await currentUser();
  if (me.orgRole !== "SUPER_ADMIN") throw new ApiError(404, "Resource not found");
  return Response.json({ jobs: await jobStatus() });
});
