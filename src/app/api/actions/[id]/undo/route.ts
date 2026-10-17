import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { undoAction } from "@/lib/undo";

const body = z.object({ anyway: z.boolean().optional() });

// SHO-US-6.4. POST { anyway: true } replaces a later change after the conflict warning.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const input = req.headers.get("content-length") === "0" ? {} : await parseBody(req, body);
  return Response.json(await undoAction(me, (await ctx.params).id, (input as { anyway?: boolean }).anyway));
});
