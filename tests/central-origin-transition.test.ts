import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invited: vi.fn(), qa: vi.fn(), secret: vi.fn(), issuer: vi.fn(),
  discovery: vi.fn(), cookies: vi.fn(), set: vi.fn(), build: vi.fn(), challenge: vi.fn(),
}));
vi.mock("@/lib/invited-central-identity", () => ({ invitedTestRealm: m.invited }));
vi.mock("@/lib/holy-qa-identity", () => ({ holyQaIdentity: m.qa, centralIdentitySecret: m.secret, centralIdentityIssuer: m.issuer }));
vi.mock("next/headers", () => ({ cookies: m.cookies }));
vi.mock("openid-client", () => ({
  discovery: m.discovery, ClientSecretBasic: () => ({}),
  randomState: () => "s".repeat(32), randomNonce: () => "n".repeat(32), randomPKCECodeVerifier: () => "v".repeat(32),
  calculatePKCECodeChallenge: m.challenge, buildAuthorizationUrl: m.build,
}));

import { centralRequestOrigin, readFlow } from "@/lib/central-client";
import { GET } from "@/app/api/auth/aplyd/start/route";

beforeEach(() => {
  vi.resetAllMocks();
  m.invited.mockReturnValue(null);
  m.qa.mockReturnValue(null);
  m.secret.mockReturnValue("test-only-central-identity-secret");
  m.issuer.mockReturnValue("https://accounts.example.test");
  m.discovery.mockResolvedValue({});
  m.cookies.mockResolvedValue({ set: m.set });
  m.challenge.mockResolvedValue("challenge");
  m.build.mockImplementation((_config, options) => new URL("https://accounts.example.test/authorize?redirect_uri=" + encodeURIComponent(options.redirect_uri)));
  process.env.APLYD_ACCOUNTS_SSO = "true";
  process.env.APLYD_ACCOUNTS_ISSUER = "https://accounts.example.test";
});

describe("central login host transition", () => {
  it.each([
    ["tasks.aplyd.org", "https://tasks.aplyd.org"],
    ["tasks.aplyd.org:443", "https://sheethappensofficer.aplyd.org"],
    ["TASKS.APLYD.ORG", "https://sheethappensofficer.aplyd.org"],
    ["tasks.aplyd.org.attacker.test", "https://sheethappensofficer.aplyd.org"],
    ["staging.tasks.aplyd.org", "https://sheethappensofficer.aplyd.org"],
  ])("maps Host %s only to an approved callback origin", (host, expected) => {
    expect(centralRequestOrigin(new Request("https://tasks.aplyd.org/", { headers: { host, "x-forwarded-host": "evil.example" } }))).toBe(expected);
  });

  it("keeps an invited or QA origin ahead of the public alias", () => {
    m.qa.mockReturnValue({ origin: "https://sho-qa.aplyd.org" });
    expect(centralRequestOrigin(new Request("https://tasks.aplyd.org/", { headers: { host: "tasks.aplyd.org" } }))).toBe("https://sheethappensofficer.aplyd.org");
  });

  it("seals the approved Tasks origin into the flow and authorization callback", async () => {
    const response = await GET(new Request("https://tasks.aplyd.org/api/auth/aplyd/start", { headers: { host: "tasks.aplyd.org" } }));
    expect(response.status).toBe(302);
    expect(m.build.mock.calls[0][1].redirect_uri).toBe("https://tasks.aplyd.org/api/auth/aplyd/callback");
    const sealed = m.set.mock.calls[0][1];
    expect(readFlow(sealed).origin).toBe("https://tasks.aplyd.org");
  });

  it("reports a fixed discovery phase without logging provider error details", async () => {
    m.discovery.mockRejectedValueOnce(new Error("provider response included secret=DO_NOT_LOG"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(new Request("https://tasks.aplyd.org/api/auth/aplyd/start", { headers: { host: "tasks.aplyd.org" } }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Central sign-in is temporarily unavailable. Existing sign-in remains available." });
      expect(log.mock.calls).toEqual([["central sign-in start failed", "discovery"]]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("DO_NOT_LOG");
    } finally { log.mockRestore(); }
  });

  it("reports a fixed cookie phase without logging flow or credential values", async () => {
    m.set.mockImplementationOnce(() => { throw new Error("cookie write secret=DO_NOT_LOG"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(new Request("https://tasks.aplyd.org/api/auth/aplyd/start", { headers: { host: "tasks.aplyd.org" } }));
      expect(response.status).toBe(503);
      expect(log.mock.calls).toEqual([["central sign-in start failed", "cookie"]]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("DO_NOT_LOG");
    } finally { log.mockRestore(); }
  });
});
