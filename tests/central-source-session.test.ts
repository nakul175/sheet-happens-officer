import { afterEach, expect, it, vi } from "vitest";
import { attachCentralSession } from "@/lib/attach-central-session";

const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    setCookie: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock("@/lib/db", () => ({
    db: {
        $transaction: (run: (transaction: unknown) => unknown) => run({
            session: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
            centralSessionLink: { upsert: mocks.upsert },
        }),
    },
}));
vi.mock("@/lib/central-status", () => ({}));
afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
});

it("retains the host-only cookie token when both Tasks domains attach the same Accounts session", async () => {
    vi.stubEnv("APLYD_ACCOUNTS_CLIENT_SECRET", "a-test-only-secret-that-is-long-enough");
    mocks.findUnique.mockResolvedValue({
        userId: "user",
        expiresAt: new Date(Date.now() + 60_000),
        user: { emailVerifiedAt: new Date() },
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await attachCentralSession("source", "user", "subject", "accounts-session");
    await attachCentralSession("source", "user", "subject", "accounts-session");
    await attachCentralSession("source", "user", "subject", "new-accounts-session");

    expect(mocks.setCookie.mock.calls[0][1]).toBe(mocks.setCookie.mock.calls[1][1]);
    expect(mocks.setCookie.mock.calls[0][1]).not.toBe(mocks.setCookie.mock.calls[2][1]);
    expect(mocks.setCookie.mock.calls[0][2]).not.toHaveProperty("domain");
});
