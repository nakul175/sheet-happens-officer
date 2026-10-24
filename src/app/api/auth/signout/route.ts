import { audit, endSession } from "@/lib/auth";
import { handle } from "@/lib/http";

export const POST = handle(async () => {
  const userId = await endSession();
  if (userId) await audit("SIGN_OUT", { actorId: userId });
  return new Response(null, { status: 204 });
});
