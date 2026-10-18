import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { resendSignIn } from "@/lib/team";

// SHO-US-15.3. Super Admin only; the check lives in resendSignIn.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  return Response.json(await resendSignIn(me, (await ctx.params).id));
});
