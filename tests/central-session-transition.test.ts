import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  transaction: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(),
  assertWorkspaceUser: vi.fn(), multiWorkspaceEnabled: vi.fn(), cookies: vi.fn(), set: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));
vi.mock("@/lib/workspace", () => ({ assertWorkspaceUser: m.assertWorkspaceUser }));
vi.mock("@/lib/workspace-authority", () => ({ multiWorkspaceEnabled: m.multiWorkspaceEnabled }));
vi.mock("@/lib/holy-qa-identity", () => ({ centralIdentitySecret: () => "test-only-central-identity-secret", holyQaIdentity: () => null }));
vi.mock("next/headers", () => ({ cookies: m.cookies }));

import { attachCentralSession } from "@/lib/attach-central-session";

beforeEach(() => {
  vi.resetAllMocks();
  m.transaction.mockImplementation(async (run) => run({
    session: { findUnique: m.findUnique, updateMany: m.updateMany },
    centralSessionLink: { upsert: m.upsert },
  }));
  m.findUnique.mockResolvedValue({ id: "source", userId: "user", revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000), centralLink: null,
    user: { workspaceId: "primary", deactivatedAt: null, emailVerifiedAt: new Date(), tempPasswordAt: null } });
  m.updateMany.mockResolvedValue({ count: 1 });
  m.cookies.mockResolvedValue({ set: m.set });
  m.multiWorkspaceEnabled.mockReturnValue(false);
});

describe("central session host transition", () => {
  it("reuses the same source-session token across host callbacks and keeps the workspace guard", async () => {
    await attachCentralSession("source", "user", "subject", "uid-1");
    const token = m.set.mock.calls[0][1];
    const hash = m.updateMany.mock.calls[0][0].data.tokenHash;
    await attachCentralSession("source", "user", "subject", "uid-1");
    expect(m.set.mock.calls[1][1]).toBe(token);
    expect(m.updateMany.mock.calls[1][0].data.tokenHash).toBe(hash);
    expect(m.assertWorkspaceUser).toHaveBeenCalledTimes(2);
    expect(m.assertWorkspaceUser).toHaveBeenCalledWith("primary", expect.anything());
  });

  it("changes the token when the central session changes", async () => {
    await attachCentralSession("source", "user", "subject", "uid-1");
    await attachCentralSession("source", "user", "subject", "uid-2");
    expect(m.set.mock.calls[1][1]).not.toBe(m.set.mock.calls[0][1]);
  });

  it("refuses a secondary workspace before rotating any token", async () => {
    m.assertWorkspaceUser.mockRejectedValue(new Error("Workspace mismatch"));
    await expect(attachCentralSession("source", "user", "subject", "uid-1")).rejects.toThrow("Workspace mismatch");
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.set).not.toHaveBeenCalled();
  });
});
