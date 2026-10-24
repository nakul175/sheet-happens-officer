import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { conciergePrefs } from "@/lib/schemas";
import { setPreferences } from "@/lib/concierge/thread";

export const PATCH = handle(async (req: Request) => {
  const me = await currentUser();
  return Response.json(await setPreferences(me, await parseBody(req, conciergePrefs)));
});
