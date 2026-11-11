import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle } from "@/lib/http";
import { issueFeed } from "@/lib/calendar";
export const GET = handle(async () => {
  const user = await currentUser();
  return Response.json({ issued: !!await db.authToken.findFirst({ where: { userId: user.id, type: "FEED", usedAt: null }, select: { id: true } }) }, { headers: { "Cache-Control": "private, no-store" } });
});
export const POST = handle(async () => {
  const secret = await issueFeed(await currentUser());
  return Response.json({ path: `/feed/${secret}.ics` }, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
});
