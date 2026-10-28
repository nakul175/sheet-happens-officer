import { currentUser } from "@/lib/auth";
import { convertProactiveToBid, proactiveToBidInput } from "@/lib/deal-pipeline";
import { handle, parseBody } from "@/lib/http";
type Ctx = { params: Promise<{ id: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const user = await currentUser();
  return Response.json({ status: "ok", ...await convertProactiveToBid(user, (await ctx.params).id, await parseBody(req, proactiveToBidInput)) });
});
