import { db } from "@/lib/db";
import { sameSecret, suiteConfig, oauthJson, readSuiteBody } from "@/lib/suite-oauth";

export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 4096) return oauthJson({ error: "invalid_request" }, 413);
    const text = await readSuiteBody(req);
    const p = JSON.parse(text);
    const cfg = suiteConfig("accounts");
    if (p.client_id !== cfg.id || typeof p.client_secret !== "string" || !sameSecret(p.client_secret, cfg.secret)) return oauthJson({ error: "invalid_client" }, 401);
    if (typeof p.user_id !== "string" || p.user_id.length > 200 || typeof p.source_session_id !== "string" || p.source_session_id.length > 200) return oauthJson({ error: "invalid_request" }, 400);
    const user = await db.user.findUnique({ where: { id: p.user_id }, select: { id: true, deactivatedAt: true, emailVerifiedAt: true, tempPasswordAt: true } });
    const session = await db.session.findUnique({ where: { id: p.source_session_id }, select: { userId: true, revokedAt: true, expiresAt: true } });
    const active = !!user && !user.deactivatedAt && !!user.emailVerifiedAt && !user.tempPasswordAt &&
      !!session && session.userId === user.id && !session.revokedAt && session.expiresAt > new Date();
    return oauthJson({ active, ...(active ? { sub: user.id } : {}) });
  } catch { return oauthJson({ error: "server_error" }, 503); }
}
