// Route-level resend race against the disposable CI database. Never use a shared DB.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { issueTokenAndSend } from "@/lib/auth";

const deliveries = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/email", async original => {
  const real = await original<typeof import("@/lib/email")>();
  return { ...real, sendMail: async () => { deliveries.count++; } };
});
import { POST as resend } from "@/app/api/auth/resend-verification/route";

const id = `resend-race-${randomUUID()}`;
const sentinelId = `resend-sentinel-${randomUUID()}`;
const email = `${id}@aplyd.com`;
let safe = false;
let createdWorkspaceId: string | null = null;

const request = () => resend(new Request("http://localhost/api/auth/resend-verification", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
}));

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test") {
    throw new Error("LOCAL_DISPOSABLE_SHO_TEST_REQUIRED");
  }
  safe = true;
  const existingWorkspace = await db.workspace.findFirst();
  const workspace = existingWorkspace ?? await db.workspace.create({ data: { name: "Synthetic resend race" } });
  if (!existingWorkspace) createdWorkspaceId = workspace.id;
  await db.user.create({ data: { id, workspaceId: workspace.id, name: "Synthetic resend race", email, passwordHash: "unused" } });
  await db.user.create({ data: { id: sentinelId, workspaceId: workspace.id, name: "Unrelated resend sentinel", email: `${sentinelId}@aplyd.com`, passwordHash: "unchanged" } });
});

afterAll(async () => {
  if (!safe) return;
  try {
    await db.auditLog.deleteMany({ where: { actorId: id } });
    await db.authToken.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } });
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: sentinelId } })).passwordHash).toBe("unchanged");
    await db.user.delete({ where: { id: sentinelId } });
    if (createdWorkspaceId) await db.workspace.delete({ where: { id: createdWorkspaceId } });
  } finally { await db.$disconnect(); }
});

it("AUTH-10 parallel resend requests keep the hourly cap and one neutral answer", async () => {
  // A prior sign-up email puts the account one delivery below the hourly cap.
  await issueTokenAndSend(id, "VERIFY", async () => {});
  await issueTokenAndSend(id, "VERIFY", async () => {});
  const answers = await Promise.all(Array.from({ length: 8 }, request));
  expect(answers.map(r => r.status)).toEqual(Array(8).fill(200));
  const bodies = await Promise.all(answers.map(r => r.json()));
  expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1);
  expect(deliveries.count).toBe(1);
  expect(await db.authToken.count({ where: { userId: id, type: "VERIFY" } })).toBe(3);
  const results = await db.auditLog.findMany({ where: { actorId: id, event: "VERIFY_EMAIL_REQUESTED" } });
  expect(results.filter(r => (r.data as { result?: string }).result === "SENT")).toHaveLength(1);
  expect(results.filter(r => (r.data as { result?: string }).result === "LIMITED")).toHaveLength(1);

  // Move only this fixture's delivery history outside the rolling hour.
  const old = new Date(Date.now() - 2 * 3600_000);
  await db.authToken.updateMany({ where: { userId: id }, data: { createdAt: old } });
  await db.auditLog.updateMany({ where: { actorId: id, event: "AUTH_EMAIL_DELIVERY" }, data: { createdAt: old } });
  expect((await request()).status).toBe(200);
  expect(deliveries.count).toBe(2);
  expect((await db.user.findUniqueOrThrow({ where: { id: sentinelId } })).passwordHash).toBe("unchanged");
});
