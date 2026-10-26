import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx, db } = vi.hoisted(() => {
  const transaction = {
    user: { upsert: vi.fn() },
    session: { deleteMany: vi.fn() },
    authToken: { deleteMany: vi.fn() },
    loginAttempt: { deleteMany: vi.fn() },
  };
  return {
    tx: transaction,
    db: {
      workspace: { findFirst: vi.fn() },
      $transaction: vi.fn(async (run: (value: typeof transaction) => Promise<void>) => run(transaction)),
    },
  };
});

vi.mock("../src/lib/db", () => ({ db }));
vi.mock("../src/lib/auth", () => ({ hashPassword: vi.fn(async (value: string) => `hashed:${value}`) }));

import { POST } from "../src/app/api/qa/accounts/route";

const TOKEN = "zz-fixture-token";
const ENV = ["MAIL_SINK", "MAIL_SINK_TOKEN", "EMAIL_OUTBOX_DIR", "APP_URL"] as const;
const saved = new Map(ENV.map((key) => [key, process.env[key]]));

function arm(host = "staging.sheethappensofficer.com") {
  process.env.MAIL_SINK = "staging";
  process.env.MAIL_SINK_TOKEN = TOKEN;
  process.env.EMAIL_OUTBOX_DIR = "/tmp/zz-test-outbox";
  process.env.APP_URL = `https://${host}`;
}

function request(accounts: unknown, token = TOKEN) {
  return new Request("https://staging.sheethappensofficer.com/api/qa/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", "x-qa-token": token },
    body: JSON.stringify({ accounts }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  db.workspace.findFirst.mockResolvedValue({ id: "workspace-test" });
  tx.user.upsert.mockResolvedValue({ id: "user-test" });
});

describe("staging QA fixture provisioning", () => {
  it("is absent on production even with the feature armed", async () => {
    arm("app.sheethappensofficer.com");
    const response = await POST(request([{ email: "zz-test-1@example.com", password: "Password9", role: "ADMIN" }]));
    expect(response.status).toBe(404);
    expect(db.workspace.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a bad token before reading fixture data", async () => {
    arm();
    const response = await POST(request([{ email: "zz-test-1@example.com", password: "Password9", role: "ADMIN" }], "wrong"));
    expect(response.status).toBe(401);
    expect(db.workspace.findFirst).not.toHaveBeenCalled();
  });

  it("rejects non-ZZ addresses, weak passwords and more than two accounts", async () => {
    arm();
    expect((await POST(request([{ email: "person@example.com", password: "Password9", role: "MEMBER" }]))).status).toBe(400);
    expect((await POST(request([{ email: "zz-test-1@example.com", password: "weak", role: "MEMBER" }]))).status).toBe(400);
    const three = [1, 2, 3].map((n) => ({ email: `zz-test-${n}@example.com`, password: "Password9", role: "MEMBER" }));
    expect((await POST(request(three))).status).toBe(400);
    expect(tx.user.upsert).not.toHaveBeenCalled();
  });

  it("resets two isolated fixtures and invalidates stale authentication state", async () => {
    arm();
    tx.user.upsert.mockResolvedValueOnce({ id: "admin-id" }).mockResolvedValueOnce({ id: "member-id" });
    const accounts = [
      { email: "zz-test-admin@example.com", password: "AdminPass9", role: "ADMIN", name: "ZZ Admin" },
      { email: "zz-test-member@example.com", password: "MemberPass9", role: "MEMBER", name: "ZZ Member" },
    ];
    const response = await POST(request(accounts));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, count: 2 });
    expect(tx.user.upsert).toHaveBeenCalledTimes(2);
    expect(tx.user.upsert.mock.calls[0][0].update).toMatchObject({
      passwordHash: "hashed:AdminPass9", emailVerifiedAt: expect.any(Date), deactivatedAt: null, tempPasswordAt: null, orgRole: "SUPER_ADMIN",
    });
    expect(tx.user.upsert.mock.calls[1][0].update.orgRole).toBe("MEMBER");
    expect(tx.session.deleteMany).toHaveBeenNthCalledWith(1, { where: { userId: "admin-id" } });
    expect(tx.authToken.deleteMany).toHaveBeenNthCalledWith(2, { where: { userId: "member-id" } });
    expect(tx.loginAttempt.deleteMany).toHaveBeenNthCalledWith(2, { where: { email: "zz-test-member@example.com" } });
    expect(JSON.stringify(await (await POST(request(accounts))).json())).not.toContain("Pass9");
  });
});
