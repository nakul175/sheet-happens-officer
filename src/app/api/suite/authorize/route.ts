import { connection } from "next/server";
import { currentUser, currentSessionId } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { suiteConfig, validAuthorization, suiteToken, suiteHash, oauthJson } from "@/lib/suite-oauth";

export async function GET(req: Request) {
  try {
    await connection();
    const url = new URL(req.url);
    const cfg = suiteConfig(url.searchParams.get("client_id") ?? "");
    if (!validAuthorization(url.searchParams, cfg)) return oauthJson({ error: "invalid_request" }, 400);
    let user;
    try { user = await currentUser(); }
    catch (err) {
      if (!(err instanceof ApiError) || ![401,403].includes(err.status)) throw err;
      if (err.status === 403) return oauthJson({ error: "access_denied", message: "Set your own password in Sheet Happens Officer before continuing." }, 403);
      const signin = new URL("/signin", cfg.origin);
      signin.searchParams.set("returnTo", `/api/suite/authorize?${url.searchParams.toString()}`);
      return new Response(null, { status: 302, headers: { Location: signin.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    const sessionId = await currentSessionId();
    if (!sessionId) return oauthJson({ error: "access_denied" }, 403);
    const code = suiteToken();
    // Short retention; no authorization code or token is logged.
    await db.suiteGrant.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86400000) } } });
    await db.suiteGrant.create({ data: { codeHash: suiteHash(code), clientId: cfg.id, userId: user.id, sessionId,
      challenge: url.searchParams.get("code_challenge")!, expiresAt: new Date(Date.now() + 60000) } });
    const callback = new URL(cfg.callback);
    callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!);
    return new Response(null, { status: 302, headers: { Location: callback.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return oauthJson({ error: "server_error" }, 503); }
}
