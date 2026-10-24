import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergeText } from "@/lib/schemas";
import { improvePrompt } from "@/lib/concierge/engine";

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  return Response.json(await improvePrompt(me, (await parseBody(req, conciergeText)).text));
});
