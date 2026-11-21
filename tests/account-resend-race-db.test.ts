import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resendSignIn } from "@/lib/team";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `account-resend-race-${randomUUID()}`;
const actor = { id: `${prefix}-admin`, orgRole: "SUPER_ADMIN" as const };
const targets: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId = "";
let safe = false;

function pauseBeforeTransaction() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let arrived = false;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    arrived = true;
    await held;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); },
    release,
  };
}

async function target() {
  const id = `${prefix}-target-${targets.length}`;
  await db.user.create({ data: { id, workspaceId, name: id, email: `${id}@example.invalid`, passwordHash: "old-hash", emailVerifiedAt: new Date() } });
  await db.session.create({ data: { userId: id, tokenHash: `${id}-session`, expiresAt: new Date(Date.now() + 3600_000) } });
  targets.push(id);
  return id;
}

async function unchanged(id: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id } });
  expect(user.passwordHash).toBe("old-hash");
  expect((await db.session.findFirstOrThrow({ where: { userId: id } })).revokedAt).toBeNull();
  expect(await db.auditLog.count({ where: { actorId: actor.id, targetId: id, event: "USER_SIGNIN_RESENT" } })).toBe(0);
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "SUPER_ADMIN" } });
  safe = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: actor.id }, data: { orgRole: "SUPER_ADMIN", deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { actorId: actor.id, targetId: { in: targets } } });
  await db.session.deleteMany({ where: { userId: { in: targets } } });
  await db.user.deleteMany({ where: { id: { in: [actor.id, ...targets] } } });
  expect(await db.user.count({ where: { id: { in: [actor.id, ...targets] } } })).toBe(0);
});

it("denies resend after the Super Admin loses authority following preflight", async () => {
  const id = await target();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([resendSignIn(actor, id)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { orgRole: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    await unchanged(id);
  } finally { pause.release(); await pending; }
});

it("denies resend when the target is deactivated after preflight", async () => {
  const id = await target();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([resendSignIn(actor, id)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 409 }) })]);
    await unchanged(id);
  } finally { pause.release(); await pending; }
});

it("resends to an eligible person and revokes the old session once", async () => {
  const id = await target();
  await resendSignIn(actor, id);
  expect((await db.user.findUniqueOrThrow({ where: { id } })).passwordHash).not.toBe("old-hash");
  expect((await db.session.findFirstOrThrow({ where: { userId: id } })).revokedAt).not.toBeNull();
  expect(await db.auditLog.count({ where: { actorId: actor.id, targetId: id, event: "USER_SIGNIN_RESENT" } })).toBe(1);
});
