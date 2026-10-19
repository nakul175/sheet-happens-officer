import { z } from "zod";
import { isAdmin } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { deactivate } from "@/lib/team";

// `reassign` is a person's id, or "leaders" for each project's Leader. Required: no silent default.
const body = z.object({ reassign: z.string().min(1) });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  // APL-2732: only an Admin may deactivate anyone, so a Member gets deactivate()'s 403 before the body is read.
  if (!isAdmin(me)) throw new ApiError(403, "You cannot deactivate this person.");
  const { reassign } = await parseBody(req, body);
  return Response.json(await deactivate(me, (await ctx.params).id, reassign));
});
