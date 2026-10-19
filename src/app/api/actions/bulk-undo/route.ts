import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { undoMany } from "@/lib/bulk";
import { handle, parseBody } from "@/lib/http";

// No length cap. undoMany pages the lookup, so a batch past 500 is undone in full (APL-2680).
const body = z.object({ ids: z.array(z.string().min(1)).min(1), anyway: z.boolean().optional() });

// SHO-US-14.11: one Undo for a whole bulk change.
// The session is checked before the body is read, so a signed-out caller gets 401, never a validation error (APL-2651).
export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const input = await parseBody(req, body);
  return Response.json(await undoMany(me, input.ids, input.anyway));
});
