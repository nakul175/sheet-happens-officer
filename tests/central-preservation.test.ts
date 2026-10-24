import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { signInDestination, suiteReturnPath } from "../src/lib/signin-destination";
const mocks = vi.hoisted(() => ({ session: vi.fn(), central: vi.fn(), active: vi.fn(), update: vi.fn() }));
vi.mock("../src/lib/db", () => ({ db: { session: { findUnique: mocks.session, update: mocks.update }, centralSessionLink: { findUnique: mocks.central } } }));
vi.mock("../src/lib/central-status", () => ({ centralSessionActive: mocks.active }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
import { sessionUser } from "../src/lib/auth";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const valid = () => ({ id: "local-session", userId: "local-user", expiresAt: new Date(Date.now() + 60000), revokedAt: null, lastSeenAt: new Date(), user: { id: "local-user", emailVerifiedAt: new Date(), deactivatedAt: null, tempPasswordAt: null } });
describe("central sign-in preservation with local authentication safeguards", () => {
  it("local sessions do not require or call the central service", async () => {
    const row = valid(); mocks.session.mockResolvedValue(row); mocks.central.mockResolvedValue(null);
    expect(await sessionUser("local-token")).toEqual(row.user); expect(mocks.active).not.toHaveBeenCalled();
  });
  it.each([false, true])("central-linked session checks central identity and active=%s", async active => {
    const row = valid(); mocks.session.mockResolvedValue(row); mocks.central.mockResolvedValue({ subject: "sub", sessionUid: "uid" }); mocks.active.mockResolvedValue(active);
    if (active) expect(await sessionUser("token")).toEqual(row.user);
    else await expect(sessionUser("token")).rejects.toMatchObject({ status: 401 });
    expect(mocks.active).toHaveBeenCalledWith("sub", "uid", "local-user");
  });
  it("revoked local sessions fail before any central lookup", async () => {
    mocks.session.mockResolvedValue({ ...valid(), revokedAt: new Date() });
    await expect(sessionUser("token")).rejects.toMatchObject({ status: 401 }); expect(mocks.central).not.toHaveBeenCalled();
  });
  it("temporary-password guard retains the shared machine-readable marker", async () => {
    const row = valid(); mocks.session.mockResolvedValue({ ...row, user: { ...row.user, tempPasswordAt: new Date() } }); mocks.central.mockResolvedValue(null);
    await expect(sessionUser("token")).rejects.toMatchObject({ status: 403, extra: { code: "PASSWORD_CHANGE_REQUIRED" } });
  });
  it("suite return targets cannot escape the authorization endpoint", () => {
    const safe = "/api/suite/authorize?client_id=bugoff&state=owned";
    expect(suiteReturnPath(safe)).toBe(safe); expect(signInDestination("/tasks/owned",safe)).toBe(safe);
    for (const bad of ["https://evil.test", "//evil.test", "/api/suite/authorize/../evil?x", "/api/suite/authorize?x#evil", "/api/suite/authorize?x\\evil", [safe], null]) expect(suiteReturnPath(bad)).toBeNull();
  });
  it("retains safe next paths when enabled and refuses external next URLs", () => {
    vi.stubEnv("SIGNIN_RETURN_TO", "1");
    expect(signInDestination("/tasks/owned", null)).toBe("/tasks/owned");
    expect(signInDestination("https://evil.test", null)).toBe("/");
    vi.stubEnv("SIGNIN_RETURN_TO", "0");
    expect(signInDestination("/tasks/owned", null)).toBe("/");
  });
  it("schema port is additive: central tables coexist with new deal fields and shutdown singleton", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    for (const token of ["model SuiteGrant", "model CentralSessionLink", "centralLink CentralSessionLink?", "enum OpportunityType", "enum AthenaEntity", "DELIVERY", "netFeeRevenueUsd", "submissionDeadlineHasTime", "isRetired"]) expect(schema).toContain(token);
    const db = readFileSync("src/lib/db.ts", "utf8"); expect(db).toContain('"../generated/prisma/client.ts"'); expect(db).toContain("globalForPrisma.prisma = db;");
  });
});
