import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ count: vi.fn(), find: vi.fn(), verify: vi.fn(), attempt: vi.fn(), clear: vi.fn(), create: vi.fn(), fresh: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ LOCKOUT_FAILURES: 5, LOCKOUT_MINUTES: 15, SESSION_DAYS: 30, verifyPassword: m.verify }));
vi.mock("../src/lib/db", () => ({ db: { user: { findUnique: m.find }, loginAttempt: { count: m.count, create: m.attempt },
  $transaction: (fn: (tx: unknown) => unknown) => fn({ user: { findUnique: m.fresh }, session: { create: m.create }, loginAttempt: { deleteMany: m.clear } }) } }));
import { POST } from "../src/app/api/suite/password/route";
const user = { id: "native-1", email: "fixture@example.invalid", name: "Fixture", passwordHash: "old-hash", emailVerifiedAt: new Date(), deactivatedAt: null, tempPasswordAt: null, orgRole: "MEMBER" };
const secret = "synthetic-only-accounts-client-0000000000";
const request = (extra = {}) => new Request("https://sho.example.invalid/api/suite/password", { method: "POST", body: JSON.stringify({ client_id: "accounts", client_secret: secret, user_id: user.id, email: user.email, password: "synthetic", ...extra }) });
beforeEach(() => { vi.stubEnv("APLYD_APEX_PASSWORD_BRIDGE", "true"); vi.stubEnv("SUITE_ACCOUNTS_CLIENT_SECRET", secret); m.count.mockResolvedValue(0); m.find.mockResolvedValue(user); m.fresh.mockResolvedValue(user); m.verify.mockResolvedValue(true); m.create.mockResolvedValue({ id: "source-1" }); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("is default off and checks client before touching identities", async () => {
  vi.stubEnv("APLYD_APEX_PASSWORD_BRIDGE", ""); expect((await POST(request())).status).toBe(404);
  vi.stubEnv("APLYD_APEX_PASSWORD_BRIDGE", "true"); expect((await POST(request({ client_secret: "wrong" }))).status).toBe(401);
  expect(m.find).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
});
it("pins native subject, creates a source session without browser cookie or role writes", async () => {
  const r = await POST(request()); expect(r.status).toBe(200); expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.json()).toEqual({ sub: user.id, email: user.email, email_verified: true, name: user.name, source_session_id: "source-1" });
  expect(m.find).toHaveBeenCalledWith({ where: { id: user.id } });
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: user.id, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) });
});
it.each(["wrong-password", "different-email", "disabled", "unverified", "temporary", "locked", "raced-reset"])("rejects %s without session creation", async kind => {
  if (kind === "wrong-password") m.verify.mockResolvedValue(false);
  if (kind === "different-email") m.find.mockResolvedValue({ ...user, email: "other@example.invalid" });
  if (kind === "disabled") m.find.mockResolvedValue({ ...user, deactivatedAt: new Date() });
  if (kind === "unverified") m.find.mockResolvedValue({ ...user, emailVerifiedAt: null });
  if (kind === "temporary") m.find.mockResolvedValue({ ...user, tempPasswordAt: new Date() });
  if (kind === "locked") m.count.mockResolvedValue(5);
  if (kind === "raced-reset") m.fresh.mockResolvedValue({ ...user, passwordHash: "new-hash" });
  expect([403, 429]).toContain((await POST(request())).status); expect(m.create).not.toHaveBeenCalled();
});
