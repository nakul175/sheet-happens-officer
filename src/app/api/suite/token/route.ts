import { connection } from "next/server";
import { db } from "@/lib/db";
import { activeSuiteIdentity, holySheetClient, oauthJson, pkceChallenge, sameSecret, suiteConfig, suiteHash, suiteToken } from "@/lib/suite-oauth";

export async function POST(req: Request) {
  try {
    await connection();
    const reader = req.body?.getReader();
    if (!reader) return oauthJson({ error: "invalid_request" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return oauthJson({ error: "invalid_request" }, 413); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const p = new URLSearchParams(body);
    const cfg = suiteConfig(p.get("client_id") ?? "");
    if (p.get("client_id") !== cfg.id || !sameSecret(p.get("client_secret") ?? "", cfg.secret)) return oauthJson({ error: "invalid_client" }, 401);
    if (p.get("grant_type") !== "authorization_code" || p.get("redirect_uri") !== cfg.callback ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(p.get("code_verifier") ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("code") ?? "")) return oauthJson({ error: "invalid_grant" }, 400);
    const grant = await db.suiteGrant.findUnique({ where: { codeHash: suiteHash(p.get("code")!) } });
    if (!grant || grant.clientId !== cfg.id || grant.redeemedAt || grant.expiresAt <= new Date() ||
      !sameSecret(grant.challenge, pkceChallenge(p.get("code_verifier")!)) ||
      !(await activeSuiteIdentity(grant.userId, grant.sessionId))) return oauthJson({ error: "invalid_grant" }, 400);
    const token = suiteToken(); const now = new Date();
    const ttl = holySheetClient(cfg.id) ? 300 : 60;
    const claimed = await db.suiteGrant.updateMany({ where: { id: grant.id, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now, accessTokenHash: suiteHash(token), accessExpiresAt: new Date(now.getTime() + ttl * 1000) } });
    if (claimed.count !== 1) return oauthJson({ error: "invalid_grant" }, 400);
    return oauthJson({ access_token: token, token_type: "Bearer", expires_in: ttl, scope: "email profile" });
  } catch { return oauthJson({ error: "server_error" }, 503); }
}
