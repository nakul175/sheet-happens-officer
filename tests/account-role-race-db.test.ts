import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { setOrgRole } from "@/lib/team";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `account-role-race-${randomUUID()}`;
const admin = { id: `${prefix}-super`, orgRole: "SUPER_ADMIN" as const };
const targets: string[] = [];
let workspaceId = "";
let safe = false;
const transact = db.$transaction.bind(db);

function pauseBeforeTransaction() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived = false;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    arrived = true;
    await gate;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() {
      await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 });
      spy.mockRestore();
    },
    release,
  };
}

async function target() {
  const id = `${prefix}-target-${targets.length}`;
  await db.user.create({ data: { id, workspaceId, name: id, email: `${id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date() } });
  targets.push(id);
  return id;
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: admin.id, workspaceId, name: admin.id, email: `${admin.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "SUPER_ADMIN" } });
  safe = true;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  await db.notification.deleteMany({ where: { OR: [{ recipientId: { in: targets } }, { actorId: admin.id }] } });
  await db.auditLog.deleteMany({ where: { actorId: admin.id } });
  await db.user.deleteMany({ where: { id: { in: [admin.id, ...targets] } } });
  expect(await db.user.count({ where: { id: { in: [admin.id, ...targets] } } })).toBe(0);
});

it("denies a role change after Super Admin authority is revoked following preflight", async () => {
  const id = await target();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([setOrgRole(admin, id, "ADMIN")]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).orgRole).toBe("MEMBER");
    expect(await db.auditLog.count({ where: { actorId: admin.id, targetId: id, event: "ADMIN_PROMOTED" } })).toBe(0);
  } finally {
    pause.release();
    await pending;
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "SUPER_ADMIN" } });
  }
}, 20_000);

it("does not demote a target newly protected as Super Admin after preflight", async () => {
  const id = await target();
  await db.user.update({ where: { id }, data: { orgRole: "ADMIN" } });
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([setOrgRole(admin, id, "MEMBER")]);
  try {
    await pause.ready();
    await db.user.update({ where: { id }, data: { orgRole: "SUPER_ADMIN" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).orgRole).toBe("SUPER_ADMIN");
    expect(await db.auditLog.count({ where: { actorId: admin.id, targetId: id, event: "ADMIN_DEMOTED" } })).toBe(0);
  } finally { pause.release(); await pending; }
}, 20_000);

it("still promotes an active ordinary member and records one audit event", async () => {
  const id = await target();
  const changed = await setOrgRole(admin, id, "ADMIN");
  expect(changed.orgRole).toBe("ADMIN");
  expect((await db.user.findUniqueOrThrow({ where: { id } })).orgRole).toBe("ADMIN");
  expect(await db.auditLog.count({ where: { actorId: admin.id, targetId: id, event: "ADMIN_PROMOTED" } })).toBe(1);
});
