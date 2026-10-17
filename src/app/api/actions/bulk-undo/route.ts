import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { undoMany } from "@/lib/bulk";
import { handle, parseBody } from "@/lib/http";

const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), anyway: z.boolean().optional() });

// SHO-US-14.11: one Undo for a whole bulk change.
export const POST = handle(async (req: Request) => {
  const input = await parseBody(req, body);
  return Response.json(await undoMany(await currentUser(), input.ids, input.anyway));
});
