import * as client from "openid-client";
import { cookies } from "next/headers";
import { centralClient, centralRequestOrigin, CENTRAL_CALLBACK_PATH, FLOW_COOKIE, flowCookieOptions, sealFlow } from "@/lib/central-client";

import { returnToEnabled, safeReturnPath } from "@/lib/return-to";

export async function GET(req: Request) {
  // A failed start must identify its step without logging provider errors, URLs,
  // flow values or credentials. The public response remains deliberately generic.
  let phase: "discovery" | "return-path" | "callback-origin" | "authorization-url" | "flow-seal" | "cookie" = "discovery";
  try {
    const config = await centralClient();
    phase = "return-path";
    const next = returnToEnabled() ? safeReturnPath(new URL(req.url).searchParams.get("next"), 1) ?? undefined : undefined;
    phase = "callback-origin";
    const origin = centralRequestOrigin(req);
    const flow = { returnPath: next, origin, state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), expires: Date.now() + 600000 };
    phase = "authorization-url";
    const url = client.buildAuthorizationUrl(config, { redirect_uri: origin + CENTRAL_CALLBACK_PATH, response_type: "code", scope: "openid email profile aplyd",
      state: flow.state, nonce: flow.nonce, code_challenge: await client.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256" });
    // Keep the encrypted cookie below browser limits even when URL canonicalization expands Unicode.
    phase = "flow-seal";
    let sealed = sealFlow(flow);
    if (sealed.length > 3800) {
      flow.returnPath = undefined;
      sealed = sealFlow(flow);
    }
    phase = "cookie";
    (await cookies()).set(FLOW_COOKIE, sealed, flowCookieOptions);
    return new Response(null, { status: 302, headers: { Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch {
    console.error("central sign-in start failed", phase);
    return Response.json({ error: "Central sign-in is temporarily unavailable. Existing sign-in remains available." }, { status: 503 });
  }
}
