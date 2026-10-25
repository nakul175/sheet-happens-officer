import * as client from "openid-client";
import { cookies } from "next/headers";
import { centralClient, CENTRAL_CALLBACK, FLOW_COOKIE, flowCookieOptions, sealFlow } from "@/lib/central-client";

import { returnToEnabled, safeReturnPath } from "@/lib/return-to";

export async function GET(req: Request) {
  try {
    const config = await centralClient();
    const next = returnToEnabled() ? safeReturnPath(new URL(req.url).searchParams.get("next"), 1) ?? undefined : undefined;
    const flow = { returnPath: next, state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), expires: Date.now() + 600000 };
    const url = client.buildAuthorizationUrl(config, { redirect_uri: CENTRAL_CALLBACK, response_type: "code", scope: "openid email profile aplyd",
      state: flow.state, nonce: flow.nonce, code_challenge: await client.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256" });
    // Keep the encrypted cookie below browser limits even when URL canonicalization expands Unicode.
    let sealed = sealFlow(flow);
    if (sealed.length > 3800) {
      flow.returnPath = undefined;
      sealed = sealFlow(flow);
    }
    (await cookies()).set(FLOW_COOKIE, sealed, flowCookieOptions);
    return new Response(null, { status: 302, headers: { Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return Response.json({ error: "Central sign-in is temporarily unavailable. Existing sign-in remains available." }, { status: 503 }); }
}
