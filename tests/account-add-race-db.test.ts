import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { addPerson } from "@/lib/team";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `account-add-race-${randomUUID()}`;
const actor = { id: `${prefix}-admin`, orgRole: "SUPER_ADMIN" as const, name: "Synthetic Admin" };
const addedIds: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId = "";
let safe = false;

function input(n: number) {
  return { firstName: "Synthetic", lastName: `Person${n}`, email: `${prefix}-person-${n}@example.invalid`, role: "MEMBER" as const };
}

function pauseBeforeTransaction() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let transactionCount = 0;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    transactionCount++;
    // Single-workspace bootstrap has its own transaction; hold the account write.
    if (transactionCount === 1) return transact(callback, options);
    await held;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() { await vi.waitFor(() => expect(transactionCount).toBe(2), { timeout: 5000 }); spy.mockRestore(); },
    release,
  };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: actor.name, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "SUPER_ADMIN" } });
  safe = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: actor.id }, data: { orgRole: "SUPER_ADMIN", deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: { in: [actor.id, ...addedIds] } } });
  expect(await db.user.count({ where: { id: { in: [actor.id, ...addedIds] } } })).toBe(0);
});

it("denies account creation when Super Admin authority is revoked after preflight", async () => {
  const person = input(1);
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addPerson(actor, person)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { orgRole: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await db.user.count({ where: { email: person.email } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: actor.id, event: "USER_ADDED_BY_ADMIN" } })).toBe(0);
  } finally { pause.release(); await pending; }
});

it("denies account creation when the actor is deactivated after preflight", async () => {
  const person = input(2);
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addPerson(actor, person)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await db.user.count({ where: { email: person.email } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: actor.id, event: "USER_ADDED_BY_ADMIN" } })).toBe(0);
  } finally { pause.release(); await pending; }
});

it("allows one eligible account creation and records the audit event", async () => {
  const person = input(3);
  const created = await addPerson(actor, person);
  addedIds.push(created.id);
  expect(created.email).toBe(person.email);
  expect((await db.user.findUniqueOrThrow({ where: { id: created.id } })).orgRole).toBe("MEMBER");
  expect(await db.auditLog.count({ where: { actorId: actor.id, targetId: created.id, event: "USER_ADDED_BY_ADMIN" } })).toBe(1);
});
