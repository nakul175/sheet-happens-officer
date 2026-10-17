import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { cancelCard } from "@/lib/concierge/cards";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ cardId: string }> }) =>
  Response.json(await cancelCard(await currentUser(), (await ctx.params).cardId)),
);
