import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { changePassword, passwordChange } from "@/lib/feed";

export const POST = handle(async (req: Request) => {
  const u = await currentUser({ allowTempPassword: true }); // SHO-US-23.5: the way out of the forced state
  const b = await parseBody(req, passwordChange);
  await changePassword(u, b.current, b.password);
  return Response.json({ status: "password_changed" });
});
