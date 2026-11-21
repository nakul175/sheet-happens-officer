import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { removeStage } from "@/lib/deals";
import { getOrCreateWorkspace } from "@/lib/workspace";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-stage-remove-${randomUUID()}`;
const actor = { id: `${prefix}-admin`, orgRole: "SUPER_ADMIN" as const };
const stageId = `${prefix}-stage`;
let dealId = "";
let targetId = "";
let pipelineId = "";
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

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  const workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: "DEAL_PROACTIVE" }, include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } });
  if (!pipeline?.stages.length) throw new Error("Disposable deal stage seed is incomplete.");
  pipelineId = pipeline.id;
  targetId = pipeline.stages[0].id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: prefix, email: `${prefix}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: "SUPER_ADMIN" } });
  await db.stage.create({ data: { id: stageId, pipelineId, name: prefix, position: 999, category: "ACTIVE", requiredFields: [] } });
  const deal = await db.project.create({ data: { workspaceId, name: `${prefix}-deal`, typeId: "wst_deal", pipelineId, stageId } });
  dealId = deal.id;
  safe = true;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  await db.auditLog.deleteMany({ where: { targetId: stageId } });
  await db.project.deleteMany({ where: { id: dealId } });
  await db.stage.deleteMany({ where: { id: stageId } });
  await db.user.deleteMany({ where: { id: actor.id } });
  expect(await db.stage.count({ where: { id: stageId } })).toBe(0);
  expect(await db.user.count({ where: { id: actor.id } })).toBe(0);
});

it("does not remove a stage after the Super Admin is deactivated following preflight", async () => {
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([removeStage(actor, stageId, { moveTo: targetId })]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.stage.findUnique({ where: { id: stageId } })).not.toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id: dealId } })).stageId).toBe(stageId);
    expect(await db.auditLog.count({ where: { event: "STAGE_REMOVED", targetId: stageId } })).toBe(0);
  } finally { pause.release(); await pending; }
}, 20_000);

it("does not remove a stage after the Super Admin role is revoked following preflight", async () => {
  await db.user.update({ where: { id: actor.id }, data: { deactivatedAt: null, orgRole: "SUPER_ADMIN" } });
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([removeStage(actor, stageId, { moveTo: targetId })]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { orgRole: "ADMIN" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.stage.findUnique({ where: { id: stageId } })).not.toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id: dealId } })).stageId).toBe(stageId);
    expect(await db.auditLog.count({ where: { event: "STAGE_REMOVED", targetId: stageId } })).toBe(0);
  } finally { pause.release(); await pending; }
}, 20_000);
