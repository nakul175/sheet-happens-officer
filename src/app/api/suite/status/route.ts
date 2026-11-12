import { activeSuiteIdentity, sameSecret, suiteConfig, oauthJson, readSuiteBody, SuiteBodyTooLargeError } from "@/lib/suite-oauth";

export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 4096) return oauthJson({ error: "invalid_request" }, 413);
    const text = await readSuiteBody(req);
    const p = JSON.parse(text);
    const cfg = suiteConfig("accounts");
    if (p.client_id !== cfg.id || typeof p.client_secret !== "string" || !sameSecret(p.client_secret, cfg.secret)) return oauthJson({ error: "invalid_client" }, 401);
    if (typeof p.user_id !== "string" || p.user_id.length > 200 || typeof p.source_session_id !== "string" || p.source_session_id.length > 200) return oauthJson({ error: "invalid_request" }, 400);
    const identity = await activeSuiteIdentity(p.user_id, p.source_session_id);
    return oauthJson({ active: !!identity, ...(identity ? { sub: identity.sub } : {}) });
  } catch (error) {
    if (error instanceof SuiteBodyTooLargeError) return oauthJson({ error: "invalid_request" }, 413);
    return oauthJson({ error: "server_error" }, 503);
  }
}
