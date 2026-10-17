import { audit, currentUser, endSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle } from "@/lib/http";

// SHO-US-1.6 AC3: ends every session of the person, this one included.
export const POST = handle(async () => {
  const me = await currentUser();
  const r = await db.session.updateMany({ where: { userId: me.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await endSession(); // clears this browser's cookie
  await audit("SIGN_OUT_ALL", { actorId: me.id, data: { sessions: String(r.count) } });
  return Response.json({ signedOut: r.count });
});
