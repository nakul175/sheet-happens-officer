import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { likelyDuplicates, dismissDuplicate } from "@/lib/duplicates";
export const GET = handle(async () => Response.json({ pairs: await likelyDuplicates(await currentUser()) }));
const dismissal = z.object({ kind: z.enum(["organisation", "contact"]), leftId: z.string().min(1), rightId: z.string().min(1) });
export const POST = handle(async (req: Request) => {
  const user = await currentUser();
  const body = await parseBody(req, dismissal);
  await dismissDuplicate(user, body.kind, body.leftId, body.rightId);
  return Response.json({ ok: true });
});
