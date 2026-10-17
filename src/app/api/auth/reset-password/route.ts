import { db } from "@/lib/db";
import { audit, consumeToken, hashPassword } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { resetInput } from "@/lib/schemas";

// SHO-US-1.4 AC2/AC4/AC6. Sets the password, signs out every session, clears any lockout.
export const POST = handle(async (req: Request) => {
  const { token, password } = await parseBody(req, resetInput);
  const userId = await consumeToken(token, "RESET");
  if (!userId) throw new ApiError(400, "This link has expired or was already used.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } }),
    db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    db.loginAttempt.deleteMany({ where: { email: user.email } }),
  ]);
  await audit("PASSWORD_RESET", { actorId: userId });
  return Response.json({ status: "password_changed" });
});
