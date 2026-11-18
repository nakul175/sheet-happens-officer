import { db } from "@/lib/db";
import { LOCKOUT_FAILURES, LOCKOUT_MINUTES, audit, clientIp, publicUser, startSession, superAdminEmails, verifyPassword } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { signInInput } from "@/lib/schemas";
import { UNVERIFIED_SIGNIN } from "@/lib/auth-messages";
import { isZzTestAddress, sinkActive } from "@/lib/mail-sink";

const WRONG = "Email or password is incorrect.";

// SHO-US-1.3. Same answer for a wrong password and for no account; lockout applies to both.
export const POST = handle(async (req: Request) => {
  const { email, password } = await parseBody(req, signInInput);
  const ip = clientIp(req);
  // Serialize the count, password check and attempt write for one email. Otherwise
  // concurrent requests can each see four failures and all pass the fifth-attempt
  // boundary. The transaction lock needs no schema change and releases on errors.
  const attempt = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_catalog.pg_advisory_xact_lock(258703, pg_catalog.hashtext(${email}))`;
    const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000);
    const failures = await tx.loginAttempt.count({ where: { email, success: false, createdAt: { gt: since } } });
    if (failures >= LOCKOUT_FAILURES) return { kind: "locked" as const };

    const user = await tx.user.findUnique({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) {
      await tx.loginAttempt.create({ data: { email, success: false } });
      return { kind: "invalid" as const, actorId: user?.id, tipped: failures + 1 >= LOCKOUT_FAILURES };
    }
    if (user.deactivatedAt) return { kind: "deactivated" as const, user };
    if (!user.emailVerifiedAt) return { kind: "unverified" as const };
    await tx.loginAttempt.deleteMany({ where: { email } });
    return { kind: "valid" as const, user };
  }, { timeout: 20_000 });

  if (attempt.kind === "locked") {
    await audit("SIGN_IN_LOCKED", { ip, data: { email } });
    throw new ApiError(429, `Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
  }
  if (attempt.kind === "invalid") {
    await audit("SIGN_IN_FAILED", { actorId: attempt.actorId, ip, data: { email } });
    // The failure that tips the account over the limit is itself the lockout event (SHO-US-6.5 AC5).
    if (attempt.tipped) await audit("SIGN_IN_LOCKED", { actorId: attempt.actorId, ip, data: { email } });
    throw new ApiError(401, WRONG);
  }
  if (attempt.kind === "deactivated") {
    await audit("SIGN_IN_REFUSED", { actorId: attempt.user.id, ip });
    throw new ApiError(403, "This account is deactivated.");
  }
  if (attempt.kind === "unverified") throw new ApiError(403, UNVERIFIED_SIGNIN, { code: "EMAIL_NOT_VERIFIED" }); // the client keys its Resend button on the code
  const user = attempt.user;

  // SHO-US-2.1 AC4: the Super Admin list is read at every sign-in. Listed means Super Admin; unlisted means Member.
  const listed = superAdminEmails().includes(user.email.toLowerCase());
  if (listed && user.orgRole !== "SUPER_ADMIN") {
    await db.user.update({ where: { id: user.id }, data: { orgRole: "SUPER_ADMIN" } });
    await audit("ORG_ROLE_CHANGED", { actorId: user.id, data: { role: "SUPER_ADMIN", source: "SUPER_ADMIN_EMAILS" } });
    user.orgRole = "SUPER_ADMIN";
  } else if (!listed && user.orgRole === "SUPER_ADMIN" && superAdminEmails().length > 0 && !(sinkActive() && isZzTestAddress(user.email))) { // an empty list never demotes anyone; isolated staging fixtures keep their provisioned role
    await db.user.update({ where: { id: user.id }, data: { orgRole: "MEMBER" } });
    await audit("ORG_ROLE_CHANGED", { actorId: user.id, data: { role: "MEMBER", source: "SUPER_ADMIN_EMAILS" } });
    user.orgRole = "MEMBER";
  }

  await startSession(user.id, req.headers.get("user-agent"));
  await audit("SIGN_IN", { actorId: user.id, ip });
  return Response.json({ user: { ...publicUser(user), mustChangePassword: !!user.tempPasswordAt } }); // SHO-US-23.5 AC8
});
