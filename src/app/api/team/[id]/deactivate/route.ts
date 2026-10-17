import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { deactivate } from "@/lib/team";

// `reassign` is a person's id, or "leaders" for each project's Leader. Required: no silent default.
const body = z.object({ reassign: z.string().min(1) });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { reassign } = await parseBody(req, body);
  return Response.json(await deactivate(me, (await ctx.params).id, reassign));
});
