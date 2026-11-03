import { db } from "@/lib/db";
import { consumeToken, hashPassword, usableToken } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { resetInput } from "@/lib/schemas";

// SHO-US-1.4 AC2/AC4/AC6. Sets the password, signs out every session, clears any lockout.
export const POST = handle(async (req: Request) => {
  const { token, password } = await parseBody(req, resetInput);
  // Reject unknown/expired links before expensive hashing; transaction rechecks eligibility.
  if (!(await usableToken(token, "RESET"))) throw new ApiError(400, "This link has expired or was already used.");
  // Hash before taking a database lock. Claim and all account changes commit together.
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    const userId = await consumeToken(token, "RESET", tx);
    if (!userId) throw new ApiError(400, "This link has expired or was already used.");
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await tx.user.update({ where: { id: userId }, data: { passwordHash, tempPasswordAt: null } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.loginAttempt.deleteMany({ where: { email: user.email } });
    await tx.auditLog.create({ data: { event: "PASSWORD_RESET", actorId: userId, channel: "SCREEN" } });
  }, { isolationLevel: "ReadCommitted" });
  return Response.json({ status: "password_changed" });
});
