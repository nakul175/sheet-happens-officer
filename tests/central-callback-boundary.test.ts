import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cookies: vi.fn(), get: vi.fn(), set: vi.fn(),
  holyQaIdentity: vi.fn(), grant: vi.fn(), findUnique: vi.fn(), audit: vi.fn(),
  attach: vi.fn(), attachQa: vi.fn(), centralSessionActive: vi.fn(), centralIdentity: vi.fn(),
  centralClient: vi.fn(), readFlow: vi.fn(), returnToEnabled: vi.fn(), safeReturnPath: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: m.cookies }));
vi.mock("openid-client", () => ({ authorizationCodeGrant: m.grant }));
vi.mock("@/lib/holy-qa-identity", () => ({ holyQaIdentity: m.holyQaIdentity }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: m.findUnique } } }));
vi.mock("@/lib/auth", () => ({ audit: m.audit }));
vi.mock("@/lib/attach-central-session", () => ({ attachCentralSession: m.attach, attachQaCentralSession: m.attachQa }));
vi.mock("@/lib/central-status", () => ({ centralSessionActive: m.centralSessionActive, centralIdentity: m.centralIdentity }));
vi.mock("@/lib/central-client", () => ({
  centralClient: m.centralClient, SHO_ORIGIN: "https://sheethappensofficer.aplyd.org",
  FLOW_COOKIE: "__Host-sho_oidc_flow", flowCookieOptions: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 },
  readFlow: m.readFlow,
}));
vi.mock("@/lib/return-to", () => ({ returnToEnabled: m.returnToEnabled, safeReturnPath: m.safeReturnPath }));

import { GET } from "@/app/api/auth/aplyd/callback/route";

const callback = "https://sheethappensofficer.aplyd.org/api/auth/aplyd/callback?code=synthetic&state=synthetic";
const valid = {
  sub: "central-subject", sho_user_id: "local-user", sho_source_session_id: "source-session",
  aplyd_session_uid: "central-session", email_verified: true,
};
const user = { id: "local-user", deactivatedAt: null, emailVerifiedAt: new Date(), tempPasswordAt: null };
const invoke = () => GET(new Request(callback));
const noSession = () => {
  expect(m.attach).not.toHaveBeenCalled();
  expect(m.attachQa).not.toHaveBeenCalled();
  expect(m.audit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  m.cookies.mockResolvedValue({ get: m.get, set: m.set });
  m.get.mockReturnValue({ value: "sealed-flow" });
  m.readFlow.mockReturnValue({ state: "state", nonce: "nonce", verifier: "verifier", expires: Date.now() + 60_000, returnPath: "/work" });
  m.centralClient.mockResolvedValue({});
  m.grant.mockResolvedValue({ claims: () => valid });
  m.holyQaIdentity.mockReturnValue(null);
  m.findUnique.mockResolvedValue(user);
  m.centralSessionActive.mockResolvedValue(true);
  m.centralIdentity.mockResolvedValue("local-user");
  m.returnToEnabled.mockReturnValue(true);
  m.safeReturnPath.mockReturnValue("/work");
});

describe("central callback fail-closed boundary", () => {
  it("expires a missing flow without contacting the authority or issuing a session", async () => {
    m.get.mockReturnValue(undefined);
    const response = await invoke();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Sign-in expired. Start again." });
    expect(m.set).toHaveBeenCalledWith("__Host-sho_oidc_flow", "", expect.objectContaining({ maxAge: 0 }));
    expect(m.centralClient).not.toHaveBeenCalled();
    noSession();
  });

  it.each(["expired or replayed flow", "rejected state, nonce or issuer", "unavailable authority"])('%s returns a safe error without a session', async (kind) => {
    if (kind === "expired or replayed flow") m.readFlow.mockImplementation(() => { throw new Error("expired flow secret"); });
    if (kind === "rejected state, nonce or issuer") m.grant.mockRejectedValue(new Error("issuer secret mismatch"));
    if (kind === "unavailable authority") m.centralClient.mockRejectedValue(new Error("authority private URL"));
    const response = await invoke();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Central sign-in could not finish. Start again." });
    expect(m.set).toHaveBeenCalledWith("__Host-sho_oidc_flow", "", expect.objectContaining({ maxAge: 0 }));
    noSession();
  });

  it.each([
    ["missing subject", { ...valid, sub: undefined }],
    ["missing local identity", { ...valid, sho_user_id: undefined }],
    ["missing source session", { ...valid, sho_source_session_id: undefined }],
    ["missing central session", { ...valid, aplyd_session_uid: undefined }],
    ["unverified email", { ...valid, email_verified: false }],
  ])('%s cannot infer a user or create a session', async (_kind, claims) => {
    m.grant.mockResolvedValue({ claims: () => claims });
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Account is not assigned." });
    expect(m.findUnique).not.toHaveBeenCalled();
    noSession();
  });

  it("rejects a changed local mapping or revoked central session", async () => {
    m.findUnique.mockResolvedValueOnce(null);
    let response = await invoke();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Account is unavailable." });
    noSession();

    m.centralSessionActive.mockResolvedValueOnce(false);
    response = await invoke();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Account is unavailable." });
    expect(m.centralSessionActive).toHaveBeenCalledWith("central-subject", "central-session", "local-user");
    noSession();
  });

  it("binds the source session and central subject, then redirects only to the fixed SHO origin", async () => {
    const response = await invoke();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sheethappensofficer.aplyd.org/work");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.grant).toHaveBeenCalledWith(expect.anything(), expect.any(URL), { pkceCodeVerifier: "verifier", expectedState: "state", expectedNonce: "nonce" });
    expect(m.findUnique).toHaveBeenCalledWith({ where: { id: "local-user" } });
    expect(m.attach).toHaveBeenCalledWith("source-session", "local-user", "central-subject", "central-session");
    expect(m.attachQa).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith("CENTRAL_SIGN_IN", { actorId: "local-user" });
  });

  it("falls back to the SHO root for an unsafe or disabled return path", async () => {
    m.safeReturnPath.mockReturnValueOnce(null);
    let response = await invoke();
    expect(response.headers.get("location")).toBe("https://sheethappensofficer.aplyd.org/");
    m.returnToEnabled.mockReturnValueOnce(false);
    response = await invoke();
    expect(response.headers.get("location")).toBe("https://sheethappensofficer.aplyd.org/");
  });

  it("QA mode requires an explicit central subject mapping and never rotates a source session", async () => {
    m.holyQaIdentity.mockReturnValue({ origin: "https://sho-qa.aplyd.org", clientId: "sho-holy-qa", subjects: [valid.sub] });
    m.centralIdentity.mockResolvedValueOnce(null);
    let response = await invoke();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Account is not assigned." });
    noSession();

    response = await invoke();
    expect(response.status).toBe(302);
    expect(m.centralIdentity).toHaveBeenCalledWith("central-subject", "central-session");
    expect(m.attachQa).toHaveBeenCalledWith("local-user", "central-subject", "central-session");
    expect(m.attach).not.toHaveBeenCalled();
  });
});
