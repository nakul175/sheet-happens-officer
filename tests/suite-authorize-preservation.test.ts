import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/http";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  currentSessionId: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("../src/lib/auth", () => ({
  currentUser: mocks.currentUser,
  currentSessionId: mocks.currentSessionId,
}));
vi.mock("../src/lib/db", () => ({
  db: { suiteGrant: { deleteMany: mocks.deleteMany, create: mocks.create } },
}));

import { GET } from "../src/app/api/suite/authorize/route";

const challenge = "c".repeat(43);
const state = "s".repeat(32);
const authorizeUrl = (overrides = "") =>
  `https://sheethappensofficer.aplyd.org/api/suite/authorize?response_type=code&scope=email+profile&state=${state}&redirect_uri=${encodeURIComponent("https://accounts.aplyd.org/bridge/callback")}&code_challenge=${challenge}&code_challenge_method=S256&client_id=accounts${overrides}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("first-party suite authorize route preservation", () => {
  it("rejects an invalid authorization request without creating a grant", async () => {
    vi.stubEnv("SUITE_ACCOUNTS_CLIENT_SECRET", "test-only-accounts-client-secret-000000000000");
    const invalid = new URL(authorizeUrl());
    invalid.searchParams.set("redirect_uri", "https://evil.invalid/callback");
    const response = await GET(new Request(invalid));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("redirects a signed-out user to the fixed SHO origin and preserves the bounded return path", async () => {
    vi.stubEnv("SUITE_ACCOUNTS_CLIENT_SECRET", "test-only-accounts-client-secret-000000000000");
    mocks.currentUser.mockRejectedValue(new ApiError(401, "Sign in required"));
    const response = await GET(new Request(authorizeUrl()));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://sheethappensofficer.aplyd.org");
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("returnTo")).toContain("/api/suite/authorize?");
    expect(location.searchParams.get("returnTo")).toContain("client_id=accounts");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a short-lived hashed grant and redirects a signed-in user to the fixed Accounts callback", async () => {
    vi.stubEnv("SUITE_ACCOUNTS_CLIENT_SECRET", "test-only-accounts-client-secret-000000000000");
    mocks.currentUser.mockResolvedValue({ id: "user-1" });
    mocks.currentSessionId.mockResolvedValue("session-1");
    const response = await GET(new Request(authorizeUrl()));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.aplyd.org/bridge/callback");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      clientId: "accounts", userId: "user-1", sessionId: "session-1", challenge,
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expect.any(Date),
    }) });
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
  });
});
