import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

export const SESSION_COOKIE = "sho_session";
export const SESSION_DAYS = 30; // fixed from sign-in, never extended
export const VERIFY_HOURS = 24;
export const RESET_HOURS = 1;
export const MAX_EMAILS_PER_HOUR = 3;
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;

const HOUR = 3600_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = sha256;

const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** SHO-US-15.2. 12 characters, letters and digits, no look-alikes (0/O, 1/l/I). Always has both a letter and a digit. */
export function generatePassword(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  for (;;) {
    const pw = Array.from({ length: 12 }, () => {
      const pool = randomInt(0, 4) === 0 ? digits : letters;
      return pool[randomInt(0, pool.length)];
    }).join("");
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Used so an unknown email costs the same time as a known one.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [alg, saltB64, keyB64] = (stored ?? DUMMY_HASH).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"));
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return stored !== null && ok;
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim().slice(0, 64) || null : null;
}

/** APL-2742. The request's user agent, cut to the same 300 characters a session stores. */
export function clientAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 300) || null;
}

/**
 * Audit rows for sign-in and email-verification events carry the IP (APL-2742 adds the user agent in data
 * for verification); no other event does. Never put secrets in data.
 */
export async function audit(
  event: string,
  o: { actorId?: string | null; ip?: string | null; data?: Record<string, string> } = {},
) {
  await db.auditLog.create({
    data: { event, actorId: o.actorId ?? null, ip: o.ip ?? null, channel: "SCREEN", data: o.data },
  });
}

export const superAdminEmails = () =>
  (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function deviceLabel(ua?: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

export async function startSession(userId: string, userAgent?: string | null) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * HOUR);
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt, userAgent: userAgent?.slice(0, 300) ?? null } });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function endSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) } });
  if (s && !s.revokedAt) await db.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  return s?.userId ?? null;
}

/** Signed-in, verified, active user, or ApiError(401). */
export async function currentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "Not signed in");
  const session = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  const u = session?.user;
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !u || u.deactivatedAt || !u.emailVerifiedAt) {
    throw new ApiError(401, "Not signed in");
  }
  // Last-active time for the Profile screen; written at most every 5 minutes.
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return u;
}

export const publicUser = (u: { id: string; name: string; email: string; orgRole: string }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  orgRole: u.orgRole,
});

/** Creates a single-use token of a type, voiding earlier unused ones of that type. Returns the raw token. */
export async function issueToken(userId: string, type: "VERIFY" | "RESET") {
  const token = newToken();
  const hours = type === "VERIFY" ? VERIFY_HOURS : RESET_HOURS;
  await db.$transaction([
    db.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    db.authToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * HOUR) },
    }),
  ]);
  return token;
}

/** True when 3 emails of this type were already issued to the user in the last hour. */
export async function emailLimitReached(userId: string, type: "VERIFY" | "RESET") {
  const n = await db.authToken.count({ where: { userId, type, createdAt: { gt: new Date(Date.now() - HOUR) } } });
  return n >= MAX_EMAILS_PER_HOUR;
}

/** Consumes a token once; returns the userId or null when unknown, used or expired. */
export async function consumeToken(raw: string, type: "VERIFY" | "RESET") {
  const hash = sha256(raw);
  const t = await db.authToken.findUnique({ where: { tokenHash: hash } });
  if (!t || t.type !== type || t.usedAt || t.expiresAt <= new Date()) return null;
  const claimed = await db.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  return claimed.count === 1 ? t.userId : null;
}

/** The id of the session making this request, or null. */
export async function currentSessionId() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await db.session.findUnique({ where: { tokenHash: sha256(token) } }))?.id ?? null;
}
