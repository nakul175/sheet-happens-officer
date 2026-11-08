// Audit: deal creation must use current actor, Leader and Buyer state at commit time.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { createDeal } from "@/lib/deals";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-create-race-${randomUUID()}`;
const actor = { id: `${prefix}-actor`, orgRole: "MEMBER" as const };
const leaderId = `${prefix}-leader`;
const projectIds: string[] = [];
let organisationId = "";
let workspaceId = "";
let pipelineId = "";
let safe = false;
let sentinel: { id: string; name: string };
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

function pauseTwoBeforeTransaction() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived = 0;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    arrived++;
    await gate;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() {
      await vi.waitFor(() => expect(arrived).toBe(2), { timeout: 5000 });
      spy.mockRestore();
    },
    release,
  };
}

function input() {
  return {
    name: `${prefix}-${randomUUID()}`,
    organisationId,
    pipelineId,
    leaderId,
    whyPursue: "Owned audit fixture",
    nextStep: { title: "First step", dueDate: "2026-12-01" },
  };
}

async function created(name: string) {
  return db.project.findMany({ where: { workspaceId, typeId: "wst_deal", name }, select: { id: true } });
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: "DEAL_PROACTIVE" } });
  if (!pipeline) throw new Error("Disposable proactive pipeline seed is incomplete.");
  pipelineId = pipeline.id;
  for (const id of [actor.id, leaderId]) {
    await db.user.create({ data: {
      id, workspaceId, name: id, email: `${id}@example.invalid`,
      passwordHash: "unused", emailVerifiedAt: new Date(),
    } });
  }
  const org = await db.organisation.create({ data: { workspaceId, name: `${prefix}-buyer`, createdById: actor.id } });
  organisationId = org.id;
  const row = await db.project.create({ data: { workspaceId, name: `${prefix}-sentinel` } });
  sentinel = { id: row.id, name: row.name };
  projectIds.push(row.id);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect(await db.project.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, name: true } })).toEqual(sentinel);
  } finally {
    try {
      const owned = await db.project.findMany({ where: { workspaceId, name: { startsWith: prefix } }, select: { id: true } });
      projectIds.push(...owned.map((p) => p.id));
      await db.actionLog.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.project.deleteMany({ where: { id: { in: projectIds } } });
      await db.organisation.deleteMany({ where: { id: organisationId } });
      await db.user.deleteMany({ where: { id: { in: [actor.id, leaderId] } } });
      expect(await db.project.count({ where: { id: { in: projectIds } } })).toBe(0);
      expect(await db.organisation.count({ where: { id: organisationId } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [actor.id, leaderId] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/deal-create-race", { recursive: true });
      writeFileSync("test-results/deal-create-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projectIds.length, organisation: 1, people: 2 }, null, 2));
    }
  }
});

it("refuses creation after the creator is deactivated following preflight", async () => {
  const data = input();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createDeal(actor, data)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: actor.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await created(data.name)).toEqual([]);
  } finally {
    pause.release(); await pending;
    await db.user.update({ where: { id: actor.id }, data: { deactivatedAt: null } });
  }
}, 20_000);

it("refuses creation after the Buyer is archived following preflight", async () => {
  const data = input();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createDeal(actor, data)]);
  try {
    await pause.ready();
    await db.organisation.update({ where: { id: organisationId }, data: { archivedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 400 }) })]);
    expect(await created(data.name)).toEqual([]);
  } finally {
    pause.release(); await pending;
    await db.organisation.update({ where: { id: organisationId }, data: { archivedAt: null } });
  }
}, 20_000);

it("refuses creation after the chosen Leader is deactivated following preflight", async () => {
  const data = input();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createDeal(actor, data)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: leaderId }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 400 }) })]);
    expect(await created(data.name)).toEqual([]);
  } finally {
    pause.release(); await pending;
    await db.user.update({ where: { id: leaderId }, data: { deactivatedAt: null } });
  }
}, 20_000);

it("allows an unchanged active creator, Leader and Buyer", async () => {
  const data = input();
  const result = await createDeal(actor, data);
  expect(result.name).toBe(data.name);
  expect((await created(data.name)).map((p) => p.id)).toEqual([result.id]);
});

it("two unconfirmed creates with the same name and Buyer have one winner", async () => {
  const data = input();
  const pause = pauseTwoBeforeTransaction();
  const pending = Promise.allSettled([createDeal(actor, data), createDeal(actor, data)]);
  try {
    await pause.ready();
    pause.release();
    const results = await pending;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 409 }) }),
    ]);
    expect(await created(data.name)).toHaveLength(1);
    await expect(createDeal(actor, data)).rejects.toMatchObject({ status: 409, extra: { needsConfirm: "duplicate" } });
  } finally { pause.release(); await pending; }
}, 20_000);
