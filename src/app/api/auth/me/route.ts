import { currentUser, publicUser } from "@/lib/auth";
import { handle } from "@/lib/http";

export const GET = handle(async () => {
  const u = await currentUser();
  return Response.json({ user: { ...publicUser(u), startGuide: !u.startGuideDismissedAt } }); // SHO-US-14.4
});
