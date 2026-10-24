import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, handle, notFound, parseBody } from "@/lib/http";
import { deactivate, mayAct } from "@/lib/team";

// `reassign` is a person's id, or "leaders" for each project's Leader. Required: no silent default.
const body = z.object({ reassign: z.string().min(1) });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  // APL-2714: the not-found and role answers deactivate gives, before the body is read.
  const target = await db.user.findUnique({ where: { id } });
  if (!target) throw notFound("Person");
  if (!mayAct(me, target)) throw new ApiError(403, "You cannot deactivate this person.");
  const { reassign } = await parseBody(req, body);
  return Response.json(await deactivate(me, id, reassign));
});
