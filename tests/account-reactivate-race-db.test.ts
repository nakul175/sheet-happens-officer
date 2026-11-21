import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reactivate } from "@/lib/team";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `reactivate-race-${randomUUID()}`;
const actor = { id: `${prefix}-admin`, orgRole: "ADMIN" as const };
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
  await db.user.create({ data: { id, workspaceId, name: id, email: `${id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), deactivatedAt: new Date() } });
  targets.push(id);
  return id;
}

async function auditCount(id: string) {
  return db.auditLog.count({ where: { actorId: actor.id, targetId: id, event: "USER_REACTIVATED" } });
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "ADMIN" } });
  safe = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: actor.id }, data: { orgRole: "ADMIN", deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { actorId: actor.id, targetId: { in: targets } } });
  await db.user.deleteMany({ where: { id: { in: [actor.id, ...targets] } } });
  expect(await db.user.count({ where: { id: { in: [actor.id, ...targets] } } })).toBe(0);
});

it("denies reactivation after the Admin loses authority following preflight", async () => {
  const id = await target();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([reactivate(actor, id)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { orgRole: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).not.toBeNull();
    expect(await auditCount(id)).toBe(0);
  } finally { pause.release(); await pending; }
});

it("denies reactivation when the target becomes protected after preflight", async () => {
  const id = await target();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([reactivate(actor, id)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id }, data: { orgRole: "SUPER_ADMIN" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).not.toBeNull();
    expect(await auditCount(id)).toBe(0);
  } finally { pause.release(); await pending; }
});

it("reactivates an eligible person once and records one audit event", async () => {
  const id = await target();
  await reactivate(actor, id);
  expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
  expect(await auditCount(id)).toBe(1);
});
