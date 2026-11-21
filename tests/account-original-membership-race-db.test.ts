import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { deactivate, reactivate } from "@/lib/team";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `original-membership-race-${randomUUID()}`;
const targets: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId = "";
let otherWorkspaceId = "";
let actor: { id: string; orgRole: "ADMIN"; workspaceId: string };
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

async function target(deactivated: boolean) {
  const id = `${prefix}-target-${targets.length}`;
  await db.user.create({ data: { id, workspaceId, name: id, email: `${id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), deactivatedAt: deactivated ? new Date() : null } });
  targets.push(id);
  return id;
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  workspaceId = (await getOrCreateWorkspace()).id;
  otherWorkspaceId = (await db.workspace.create({ data: { name: `${prefix}-other` } })).id;
  actor = { id: `${prefix}-admin`, orgRole: "ADMIN", workspaceId };
  await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "ADMIN" } });
  safe = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (safe) await db.workspaceMembership.deleteMany({ where: { userId: { in: targets } } });
});
afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { actorId: actor.id, targetId: { in: targets } } });
  await db.user.deleteMany({ where: { id: { in: [actor.id, ...targets] } } });
  await db.workspace.delete({ where: { id: otherWorkspaceId } });
  expect(await db.user.count({ where: { id: { in: [actor.id, ...targets] } } })).toBe(0);
});

it("denies deactivation after the target gains an additional workspace membership", async () => {
  const id = await target(false);
  vi.stubEnv("SHO_MULTI_WORKSPACE_ENABLED", "true");
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([deactivate(actor, id, "leaders")]);
  try {
    await pause.ready();
    await db.workspaceMembership.create({ data: { userId: id, workspaceId: otherWorkspaceId, role: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    expect(await db.auditLog.count({ where: { actorId: actor.id, targetId: id, event: "USER_DEACTIVATED" } })).toBe(0);
  } finally { pause.release(); await pending; }
});

it("denies reactivation after the target gains an additional workspace membership", async () => {
  const id = await target(true);
  vi.stubEnv("SHO_MULTI_WORKSPACE_ENABLED", "true");
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([reactivate(actor, id)]);
  try {
    await pause.ready();
    await db.workspaceMembership.create({ data: { userId: id, workspaceId: otherWorkspaceId, role: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { actorId: actor.id, targetId: id, event: "USER_REACTIVATED" } })).toBe(0);
  } finally { pause.release(); await pending; }
});

it("holds a new membership insert behind the target account lock", async () => {
  const id = await target(false);
  let locked!: () => void;
  let release!: () => void;
  const lockReady = new Promise<void>((resolve) => { locked = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const locking = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE NOWAIT`;
    expect(await tx.workspaceMembership.count({ where: { userId: id } })).toBe(0);
    locked();
    await held;
  });
  try {
    await lockReady;
    const blocked = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
      await tx.$executeRaw`INSERT INTO "WorkspaceMembership" ("userId", "workspaceId", "role") VALUES (${id}, ${otherWorkspaceId}, 'MEMBER')`;
    }).then(() => null, (error: { code?: string; meta?: { code?: string } }) => error);
    expect(blocked).toMatchObject({ code: "P2010", meta: { code: "55P03" } });
    expect(await db.workspaceMembership.count({ where: { userId: id } })).toBe(0);
  } finally { release(); await locking; }
});
