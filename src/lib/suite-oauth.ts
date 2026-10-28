import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { holyQaRealm } from "@/lib/holy-qa-identity";
import { db } from "@/lib/db";
import { centralSessionActive } from "@/lib/central-status";
import { ApiError } from "@/lib/http";

export const suiteHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const suiteToken = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url");
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
export function suiteConfig(id = "bugoff") {
  if (!["bugoff", "accounts", "holy-sheet", "holy-sheet-staging"].includes(id)) throw new Error("Unknown suite client");
  const secret = id === "accounts" ? process.env.SUITE_ACCOUNTS_CLIENT_SECRET
    : id === "holy-sheet" ? process.env.SUITE_HOLY_SHEET_CLIENT_SECRET
      : id === "holy-sheet-staging" ? process.env.SUITE_HOLY_SHEET_STAGING_CLIENT_SECRET
        : process.env.SUITE_BUGOFF_CLIENT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Suite sign-in not configured");
  const realm = id === "accounts" ? holyQaRealm() : null;
  const origin = realm?.origin ?? (id === "holy-sheet-staging"
    ? "https://staging.sheethappensofficer.com"
    : "https://sheethappensofficer.aplyd.org");
  return {
    id,
    secret,
    origin,
    callback: id === "accounts" ? (realm ? realm.origin + "/bridge/callback" : "https://accounts.aplyd.org/bridge/callback")
      : id === "holy-sheet" ? "https://holysheet.aplyd.org/integrations/sho/callback"
        : id === "holy-sheet-staging" ? "https://staging.holysheet.aplyd.org/integrations/sho/callback"
          : "https://bugoff.aplyd.org/api/auth/callback/aplyd",
  };
}

export const holySheetClient = (id: string) => id === "holy-sheet" || id === "holy-sheet-staging";

/** Resolve a first-party bearer token to the live SHO user and central Accounts subject. */
export async function holySheetSuiteActor(req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new ApiError(401, "Sign in to Sheet Happens Officer.");
  const grant = await db.suiteGrant.findUnique({ where: { accessTokenHash: suiteHash(token) } });
  if (!grant || !holySheetClient(grant.clientId) || !grant.accessExpiresAt || grant.accessExpiresAt <= new Date())
    throw new ApiError(401, "Your Sheet Happens Officer session expired.");
  const identity = await activeSuiteIdentity(grant.userId, grant.sessionId);
  const link = await db.centralSessionLink.findUnique({ where: { sessionId: grant.sessionId } });
  if (!identity || !link || !(await centralSessionActive(link.subject, link.sessionUid, grant.userId)))
    throw new ApiError(401, "Your Aplyd session expired.");
  const user = await db.user.findUnique({ where: { id: grant.userId }, select: { id: true, name: true, orgRole: true } });
  if (!user) throw new ApiError(401, "Your Sheet Happens Officer account is unavailable.");
  return { user, subject: link.subject, grant };
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
