import { holyQaIdentity } from "@/lib/holy-qa-identity";
import * as client from "openid-client";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { attachCentralSession, attachQaCentralSession } from "@/lib/attach-central-session";
import { centralSessionActive, centralIdentity } from "@/lib/central-status";
import { centralClient, SHO_ORIGIN, FLOW_COOKIE, flowCookieOptions, readFlow } from "@/lib/central-client";
import { returnToEnabled, safeReturnPath } from "@/lib/return-to";
export async function GET(req: Request) {
    try {
        const jar = await cookies(), value = jar.get(FLOW_COOKIE)?.value;
        jar.set(FLOW_COOKIE, "", { ...flowCookieOptions, maxAge: 0 });
        if (!value)
            return Response.json({ error: "Sign-in expired. Start again." }, { status: 400 });
        const flow = readFlow(value), config = await centralClient();
        const incoming = new URL(req.url), callback = new URL(incoming.pathname + incoming.search, SHO_ORIGIN);
        const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
        const claims = tokens.claims(), qa = holyQaIdentity();
        if (!claims || typeof claims.sub !== "string" || (!qa && typeof claims.sho_user_id !== "string") ||
            typeof claims.aplyd_session_uid !== "string" || (!qa && typeof claims.sho_source_session_id !== "string") || claims.email_verified !== true)
            return Response.json({ error: "Account is not assigned." }, { status: 403 });
        const localId = qa ? await centralIdentity(claims.sub, claims.aplyd_session_uid) : claims.sho_user_id as string;
        if (!localId)
            return Response.json({ error: "Account is not assigned." }, { status: 403 });
        const user = await db.user.findUnique({ where: { id: localId } });
        if (!user || user.deactivatedAt || !user.emailVerifiedAt || user.tempPasswordAt ||
            !(await centralSessionActive(claims.sub, claims.aplyd_session_uid, user.id)))
            return Response.json({ error: "Account is unavailable." }, { status: 403 });
        if (qa)
            await attachQaCentralSession(user.id, claims.sub, claims.aplyd_session_uid);
        else
            await attachCentralSession(claims.sho_source_session_id as string, user.id, claims.sub, claims.aplyd_session_uid);
        await audit("CENTRAL_SIGN_IN", { actorId: user.id });
        return new Response(null, { status: 302, headers: { Location: SHO_ORIGIN + (returnToEnabled() ? safeReturnPath(flow.returnPath, 1) ?? "/" : "/"), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    catch {
        return Response.json({ error: "Central sign-in could not finish. Start again." }, { status: 400 });
    }
}
