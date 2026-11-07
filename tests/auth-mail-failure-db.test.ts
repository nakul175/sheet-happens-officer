import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { consumeToken, hashToken, issueTokenAndSend } from "@/lib/auth";
import { getOrCreateWorkspace } from "@/lib/workspace";

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/email", () => ({
  MailError: class MailError extends Error {},
  resetMail: () => ({ to: "synthetic@example.invalid" }),
  sendMail: mail.send,
}));
import { MailError } from "@/lib/email";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";

const fixture = randomUUID();
const userId = `recovery-delivery-${fixture}`;
const sentinelId = `recovery-sentinel-${fixture}`;
const email = `${userId}@example.invalid`;
let safe = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test")
    throw new Error("LOCAL_DISPOSABLE_SHO_TEST_REQUIRED");
  safe = true;
  const workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.createMany({ data: [
    { id: userId, workspaceId, name: "Synthetic recovery delivery", email, passwordHash: "unused" },
    { id: sentinelId, workspaceId, name: "Synthetic unrelated sentinel", email: `${sentinelId}@example.invalid`, passwordHash: "sentinel" },
  ] });
});

afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { actorId: userId } });
  await db.authToken.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: { in: [userId, sentinelId] } } });
  await db.$disconnect();
});

it("SHO-REG-AUTH-07: failed recovery mail retains the old link and frees token quota", async () => {
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinelId } });
  const prior = await issueTokenAndSend(userId, "RESET", async () => {});
  mail.send.mockRejectedValueOnce(new MailError("synthetic provider failure"));

  const response = await forgotPassword(new Request("http://localhost/api/auth/forgot-password", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    message: "If an account exists for this address, a reset link is on its way. You can ask up to 3 times an hour; if you have asked that often already, try again later.",
  });
  expect(mail.send).toHaveBeenCalledTimes(1);

  const tokens = await db.authToken.findMany({ where: { userId, type: "RESET" } });
  expect(tokens).toHaveLength(1);
  expect(tokens[0].tokenHash).toBe(hashToken(prior));
  expect(tokens[0].usedAt).toBeNull();
  expect(await db.auditLog.count({ where: {
    actorId: userId, event: "AUTH_EMAIL_DELIVERY", data: { path: ["result"], equals: "FAILED" },
  } })).toBe(1);
  expect(await consumeToken(prior, "RESET")).toBe(userId);

  // A failed send does not consume one of the three successful-token slots.
  await issueTokenAndSend(userId, "RESET", async () => {});
  await issueTokenAndSend(userId, "RESET", async () => {});
  expect(await db.authToken.count({ where: { userId, type: "RESET" } })).toBe(3);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinelId } })).toEqual(sentinelBefore);
});
