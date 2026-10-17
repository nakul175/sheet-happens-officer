import { db } from "@/lib/db";
import { LOCKOUT_FAILURES, LOCKOUT_MINUTES, audit, clientIp, publicUser, startSession, verifyPassword } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { signInInput } from "@/lib/schemas";

const WRONG = "Email or password is incorrect.";

// SHO-US-1.3. Same answer for a wrong password and for no account; lockout applies to both.
export const POST = handle(async (req: Request) => {
  const { email, password } = await parseBody(req, signInInput);
  const ip = clientIp(req);
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000);

  const failures = await db.loginAttempt.count({ where: { email, success: false, createdAt: { gt: since } } });
  if (failures >= LOCKOUT_FAILURES) {
    await audit("SIGN_IN_LOCKED", { ip, data: { email } });
    throw new ApiError(429, `Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
  }

  const user = await db.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !ok) {
    await db.loginAttempt.create({ data: { email, success: false } });
    await audit("SIGN_IN_FAILED", { actorId: user?.id, ip, data: { email } });
    throw new ApiError(401, WRONG);
  }
  if (user.deactivatedAt) {
    await audit("SIGN_IN_REFUSED", { actorId: user.id, ip });
    throw new ApiError(403, "This account is deactivated.");
  }
  if (!user.emailVerifiedAt) throw new ApiError(403, "Verify your email first.");

  await db.loginAttempt.deleteMany({ where: { email } });
  await startSession(user.id);
  await audit("SIGN_IN", { actorId: user.id, ip });
  return Response.json({ user: publicUser(user) });
});
