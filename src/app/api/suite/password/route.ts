/** First-party credential check for the apex UI. No browser cookie or role edits. */
import { connection } from "next/server";
import { db } from "@/lib/db";
import { LOCKOUT_FAILURES, LOCKOUT_MINUTES, SESSION_DAYS, verifyPassword } from "@/lib/auth";
import { oauthJson, readSuiteBody, sameSecret, suiteConfig, suiteHash, suiteToken } from "@/lib/suite-oauth";
import { signInInput } from "@/lib/schemas";

export async function POST(req: Request) {
  if (process.env.APLYD_APEX_PASSWORD_BRIDGE !== "true") return oauthJson({ error: "unavailable" }, 404);
  try {
    await connection();
    const body = JSON.parse(await readSuiteBody(req));
    const cfg = suiteConfig("accounts");
    if (body.client_id !== "accounts" || typeof body.client_secret !== "string" || !sameSecret(body.client_secret, cfg.secret))
      return oauthJson({ error: "invalid_client" }, 401);
    if (body.purpose !== undefined && body.purpose !== "account-link-proof")
      return oauthJson({ error: "invalid_request" }, 400);
    const { email, password } = signInInput.parse(body);
    if (typeof body.user_id !== "string" || !body.user_id || body.user_id.length > 200 || body.user_id.startsWith("central-invited:"))
      return oauthJson({ error: "access_denied" }, 403);
    const since = new Date(Date.now() - LOCKOUT_MINUTES * 60000);
    const failures = await db.loginAttempt.count({ where: { email, success: false, createdAt: { gt: since } } });
    if (failures >= LOCKOUT_FAILURES) return oauthJson({ error: "access_denied" }, 429);
    const user = await db.user.findUnique({ where: { id: body.user_id } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!ok || !user || user.email.toLowerCase() !== email || user.deactivatedAt || !user.emailVerifiedAt || user.tempPasswordAt) {
      await db.loginAttempt.create({ data: { email, success: false } });
      return oauthJson({ error: "access_denied" }, 403);
    }
    const source = await db.$transaction(async tx => {
      const fresh = await tx.user.findUnique({ where: { id: user.id } });
      if (!fresh || fresh.passwordHash !== user.passwordHash || fresh.email !== user.email || fresh.deactivatedAt || !fresh.emailVerifiedAt || fresh.tempPasswordAt)
        throw Error("Identity changed");
      // Reverification must not mint an orphan native session or reset login attempts.
      if (body.purpose === "account-link-proof") return undefined;
      const session = await tx.session.create({ data: { userId: user.id,
        tokenHash: suiteHash(suiteToken()), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000), userAgent: "Aplyd central sign-in" } });
      await tx.loginAttempt.deleteMany({ where: { email } });
      return session.id;
    });
    return oauthJson({ sub: user.id, email: user.email, email_verified: true, name: user.name,
      ...(body.purpose === "account-link-proof" ? { purpose: "account-link-proof" } : { source_session_id: source }) });
  } catch { return oauthJson({ error: "access_denied" }, 403); }
}
