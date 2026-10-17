import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { requestToBeAdded } from "@/lib/orientation";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json(await requestToBeAdded(await currentUser(), (await ctx.params).id)));
