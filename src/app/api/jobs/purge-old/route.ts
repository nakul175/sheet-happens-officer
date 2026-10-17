import { timingSafeEqual } from "node:crypto";
import { ApiError, handle } from "@/lib/http";
import { purgeOld } from "@/lib/feed";

// Called by the server's cron with the JOB_SECRET (story 9.3). Not reachable by signed-in people.
export const POST = handle(async (req: Request) => {
  const secret = process.env.JOB_SECRET ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const ok = secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new ApiError(401, "Not allowed");
  return Response.json({ purged: await purgeOld() });
});
