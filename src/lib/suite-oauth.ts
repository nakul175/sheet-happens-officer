import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export const suiteHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const suiteToken = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url");
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
export function suiteConfig(id = "bugoff") {
  if (!["bugoff", "accounts"].includes(id)) throw new Error("Unknown suite client");
  const secret = id === "accounts" ? process.env.SUITE_ACCOUNTS_CLIENT_SECRET : process.env.SUITE_BUGOFF_CLIENT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Suite sign-in not configured");
  return {
    id,
    secret,
    origin: "https://sheethappensofficer.aplyd.org",
    callback: id === "accounts" ? "https://accounts.aplyd.org/bridge/callback" : "https://bugoff.aplyd.org/api/auth/callback/aplyd",
  };
}
export function validAuthorization(p: URLSearchParams, cfg: ReturnType<typeof suiteConfig>) {
  return p.get("client_id") === cfg.id && p.get("redirect_uri") === cfg.callback &&
    p.get("response_type") === "code" && p.get("code_challenge_method") === "S256" &&
    /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "") &&
    /^[A-Za-z0-9_-]{16,256}$/.test(p.get("state") ?? "");
}
export async function activeSuiteIdentity(userId: string, sessionId: string) {
  const session = await db.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  const user = session?.user;
  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date() ||
      !user || user.deactivatedAt || !user.emailVerifiedAt || user.tempPasswordAt) return null;
  return { sub: user.id, email: user.email, email_verified: true, name: user.name };
}
export function oauthJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer" } });
}

export async function readSuiteBody(req: Request, limit = 4096): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Body required");
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error("Body too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
