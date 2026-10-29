import { connection } from "next/server";
import { db } from "@/lib/db";
import { activeSuiteIdentity, oauthJson, suiteHash } from "@/lib/suite-oauth";

export async function GET(req: Request) {
  try {
    await connection();
    const token = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return oauthJson({ error: "invalid_token" }, 401);
    const grant = await db.suiteGrant.findUnique({ where: { accessTokenHash: suiteHash(token) } });
    if (!grant?.accessExpiresAt || grant.accessExpiresAt <= new Date()) return oauthJson({ error: "invalid_token" }, 401);
    const identity = await activeSuiteIdentity(grant.userId, grant.sessionId);
    return identity ? oauthJson({ ...identity, ...(grant.clientId === "accounts" ? { source_session_id: grant.sessionId } : {}) }) : oauthJson({ error: "invalid_token" }, 401);
  } catch { return oauthJson({ error: "server_error" }, 503); }
}
