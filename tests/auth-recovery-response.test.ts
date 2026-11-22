import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), limit: vi.fn(), issue: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: m.user, create: m.create } } }));
vi.mock("@/lib/workspace", () => ({ getOrCreateWorkspace: async () => ({ id: "synthetic-workspace" }) }));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  AuthMailLimitError: class extends Error {},
  emailLimitReached: m.limit,
  issueTokenAndSend: m.issue,
  audit: vi.fn(), hashPassword: async () => "synthetic-hash", superAdminEmails: () => [],
}));
vi.mock("@/lib/email", () => ({ MailError: class extends Error {}, resetMail: vi.fn(), verifyMail: vi.fn(), sendMail: m.send, VERIFY_SEND_FAILED: "Synthetic delivery failure notice" }));
import { AuthMailLimitError } from "@/lib/auth";
import { MailError } from "@/lib/email";
import { POST } from "@/app/api/auth/forgot-password/route";
import { POST as signup } from "@/app/api/auth/signup/route";

const request = () => new Request("http://localhost/api/auth/forgot-password", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "synthetic@aplyd.com" }),
});
const neutral = {
  status: "ok",
  message: "If an account exists for this address, a reset link is on its way. You can ask up to 3 times an hour; if you have asked that often already, try again later.",
};
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "synthetic", deactivatedAt: null });
  m.limit.mockResolvedValue(false);
});
for (const outcome of ["sent", "provider-failure", "concurrent-limit", "prechecked-limit", "unknown", "inactive"] as const) {
  it(`password recovery keeps the same neutral answer for ${outcome}`, async () => {
    if (outcome === "provider-failure") m.issue.mockRejectedValue(new MailError("synthetic provider error"));
    if (outcome === "concurrent-limit") m.issue.mockRejectedValue(new AuthMailLimitError());
    if (outcome === "prechecked-limit") m.limit.mockResolvedValue(true);
    if (outcome === "unknown") m.user.mockResolvedValue(null);
    if (outcome === "inactive") m.user.mockResolvedValue({ id: "synthetic", deactivatedAt: new Date() });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(neutral);
    if (["prechecked-limit", "unknown", "inactive"].includes(outcome)) expect(m.issue).not.toHaveBeenCalled();
    else expect(m.issue).toHaveBeenCalledWith("synthetic", "RESET", expect.any(Function));
  });
}
it("does not disguise an unexpected database failure as a successful recovery request", async () => {
  m.issue.mockRejectedValue(new Error("synthetic internal failure"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("synthetic internal failure");
});
for (const outcome of ["provider-failure", "concurrent-limit"] as const) {
  it(`signup acknowledges the created account when its first email meets ${outcome}`, async () => {
    m.user.mockResolvedValue(null);
    m.create.mockResolvedValue({ id: "synthetic" });
    m.issue.mockRejectedValue(outcome === "provider-failure" ? new MailError("synthetic failure") : new AuthMailLimitError());
    const response = await signup(new Request("http://localhost/api/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic", email: "synthetic@aplyd.com", password: "SyntheticPassword123!" }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "check_email", emailSent: false });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(m.create).toHaveBeenCalledTimes(1);
  });
}
