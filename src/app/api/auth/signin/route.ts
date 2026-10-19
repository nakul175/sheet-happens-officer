import { db } from "@/lib/db";
import { LOCKOUT_FAILURES, LOCKOUT_MINUTES, audit, clientIp, publicUser, startSession, superAdminEmails, verifyPassword } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { signInInput } from "@/lib/schemas";

const WRONG = "Email or password is incorrect.";
// APL-2742. The client shows a Resend button on this code, not on the wording.
const UNVERIFIED = "Verify your email before you sign in. Open the link we emailed you, or resend it.";

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
    // The failure that tips the account over the limit is itself the lockout event (SHO-US-6.5 AC5).
    if (failures + 1 >= LOCKOUT_FAILURES) await audit("SIGN_IN_LOCKED", { actorId: user?.id, ip, data: { email } });
    throw new ApiError(401, WRONG);
  }
  if (user.deactivatedAt) {
    await audit("SIGN_IN_REFUSED", { actorId: user.id, ip });
    throw new ApiError(403, "This account is deactivated.");
  }
  if (!user.emailVerifiedAt) throw new ApiError(403, UNVERIFIED, { code: "EMAIL_NOT_VERIFIED" });

  // SHO-US-2.1 AC4: the Super Admin list is read at every sign-in. Listed means Super Admin; unlisted means Member.
  const listed = superAdminEmails().includes(user.email.toLowerCase());
  if (listed && user.orgRole !== "SUPER_ADMIN") {
    await db.user.update({ where: { id: user.id }, data: { orgRole: "SUPER_ADMIN" } });
    await audit("ORG_ROLE_CHANGED", { actorId: user.id, data: { role: "SUPER_ADMIN", source: "SUPER_ADMIN_EMAILS" } });
    user.orgRole = "SUPER_ADMIN";
  } else if (!listed && user.orgRole === "SUPER_ADMIN" && superAdminEmails().length > 0) { // an empty list never demotes anyone
    await db.user.update({ where: { id: user.id }, data: { orgRole: "MEMBER" } });
    await audit("ORG_ROLE_CHANGED", { actorId: user.id, data: { role: "MEMBER", source: "SUPER_ADMIN_EMAILS" } });
    user.orgRole = "MEMBER";
  }

  await db.loginAttempt.deleteMany({ where: { email } });
  await startSession(user.id, req.headers.get("user-agent"));
  await audit("SIGN_IN", { actorId: user.id, ip });
  return Response.json({ user: publicUser(user) });
});
