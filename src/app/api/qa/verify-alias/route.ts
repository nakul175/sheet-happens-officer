import { handle } from "@/lib/http";
import { verifyPoolAlias } from "@/lib/qa-verify";

// APL-2925. Staging only (QA_VERIFY_ALIASES=1, JOB_SECRET in X-Job-Secret); 404 everywhere else. See src/lib/qa-verify.ts.
export const POST = handle(async (req: Request) => {
  let body: { email?: unknown } = {};
  try { body = (await req.json()) as { email?: unknown }; } catch { /* a missing email is refused below */ }
  return Response.json(await verifyPoolAlias(body.email, req.headers.get("x-job-secret") ?? ""));
});
