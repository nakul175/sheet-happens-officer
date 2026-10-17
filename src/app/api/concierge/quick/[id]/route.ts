import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { quickAction } from "@/lib/concierge/engine";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json(await quickAction(await currentUser(), (await ctx.params).id)),
);
