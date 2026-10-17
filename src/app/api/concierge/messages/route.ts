import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergeText } from "@/lib/schemas";
import { sendMessage } from "@/lib/concierge/engine";
import { clearChat } from "@/lib/concierge/thread";

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  return Response.json(await sendMessage(me, (await parseBody(req, conciergeText)).text));
});

// "Clear my chat": the whole thread at once.
export const DELETE = handle(async () => {
  await clearChat(await currentUser());
  return Response.json({ ok: true });
});
