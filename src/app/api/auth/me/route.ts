import { currentUser, publicUser } from "@/lib/auth";
import { handle } from "@/lib/http";

export const GET = handle(async () => {
  const u = await currentUser({ allowTempPassword: true });
  return Response.json({ user: { ...publicUser(u), startGuide: !u.startGuideDismissedAt, mustChangePassword: !!u.tempPasswordAt } }); // SHO-US-14.4, 23.5
});
