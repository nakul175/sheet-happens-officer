import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergeChoice } from "@/lib/schemas";
import { answerChoice } from "@/lib/concierge/engine";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ messageId: string }> }) => {
  const me = await currentUser();
  return Response.json(await answerChoice(me, (await ctx.params).messageId, (await parseBody(req, conciergeChoice)).choiceId));
});
