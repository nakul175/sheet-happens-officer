// Direct Buyer replacement versus Leader, account, and organisation changes on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { replaceBuyer } from "@/lib/deals";
import { changeLeader } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-buyer-replace-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const successor = { id: `${prefix}-successor`, orgRole: "MEMBER" as const };
const projects: string[] = [];
const organisations: string[] = [];
let workspaceId = "";
let pipelineId = "";
let safe = false;
let sentinel: { id: string; name: string };
const transact = db.$transaction.bind(db);

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix, typeId: "wst_deal", pipelineId } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: successor.id, role: "EDITOR" },
  ] });
  await db.dealDetails.create({ data: { projectId: project.id, workspaceId, whyPursue: "Owned Buyer race" } });
  const oldOrg = await db.organisation.create({ data: { workspaceId, name: `${prefix}-old`, createdById: leader.id } });
  const newOrg = await db.organisation.create({ data: { workspaceId, name: `${prefix}-new`, createdById: leader.id } });
  organisations.push(oldOrg.id, newOrg.id);
  const party = await db.dealParty.create({ data: { projectId: project.id, organisationId: oldOrg.id, role: "BUYER" } });
  return {
    projectId: project.id, partyId: party.id, oldOrgId: oldOrg.id, newOrgId: newOrg.id,
    input: { organisationId: newOrg.id, expectedPartyId: party.id, expectedOrganisationId: oldOrg.id },
  };
}

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

async function state(projectId: string) {
  const [parties, actions] = await Promise.all([
    db.dealParty.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
  ]);
  return { parties, actions };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: "DEAL_PROACTIVE" } });
  if (!pipeline) throw new Error("Disposable proactive pipeline seed is incomplete.");
  pipelineId = pipeline.id;
  for (const person of [leader, successor]) {
    await db.user.create({ data: {
      id: person.id, workspaceId, name: person.id, email: `${person.id}@example.invalid`,
      passwordHash: "unused", emailVerifiedAt: new Date(),
    } });
  }
  const row = await db.project.create({ data: { workspaceId, name: `${prefix}-sentinel` } });
  sentinel = { id: row.id, name: row.name };
  projects.push(row.id);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect(await db.project.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, name: true } })).toEqual(sentinel);
  } finally {
    try {
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.organisation.deleteMany({ where: { id: { in: organisations } } });
      await db.user.deleteMany({ where: { id: { in: [leader.id, successor.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, successor.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/deal-buyer-replace-race", { recursive: true });
      writeFileSync("test-results/deal-buyer-replace-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, organisations: organisations.length, people: 2 }, null, 2));
    }
  }
});

it("Leader downgrade after preflight denies Buyer replacement", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([replaceBuyer(leader, f.projectId, f.input)]);
  try {
    await pause.ready();
    await changeLeader(leader, f.projectId, { newLeaderId: successor.id, previousRole: "EDITOR" });
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("account deactivation after preflight denies Buyer replacement", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([replaceBuyer(leader, f.projectId, f.input)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } });
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: null } }); }
}, 20_000);

it("replacement organisation archive after preflight denies Buyer replacement", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([replaceBuyer(leader, f.projectId, f.input)]);
  try {
    await pause.ready();
    await db.organisation.update({ where: { id: f.newOrgId }, data: { archivedAt: new Date() } });
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 400 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Leader replaces the Buyer once and records one action", async () => {
  const f = await fixture();
  await replaceBuyer(leader, f.projectId, f.input);
  const after = await state(f.projectId);
  expect(after.parties.filter((p) => p.role === "BUYER")).toEqual([expect.objectContaining({ id: f.partyId, organisationId: f.newOrgId })]);
  expect(after.actions.filter((a) => a.action === "deal.buyer_replaced")).toHaveLength(1);
});
