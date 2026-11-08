// Direct deal-party additions versus membership and organisation archive changes on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { addParty } from "@/lib/deals";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-party-add-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
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
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
  ] });
  await db.dealDetails.create({ data: { projectId: project.id, workspaceId, whyPursue: "Owned party race" } });
  const org = await db.organisation.create({ data: { workspaceId, name: `${prefix}-org`, createdById: leader.id } });
  organisations.push(org.id);
  return { projectId: project.id, orgId: org.id };
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
  for (const person of [leader, editor]) {
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
      await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, editor.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/deal-party-add-race", { recursive: true });
      writeFileSync("test-results/deal-party-add-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, organisations: organisations.length, people: 2 }, null, 2));
    }
  }
});

it("removal after preflight denies a direct party addition", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addParty(editor, f.projectId, f.orgId, "PARTNER")]);
  try {
    await pause.ready();
    await removeMember(leader, f.projectId, editor.id);
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("Viewer downgrade after preflight denies a direct party addition", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addParty(editor, f.projectId, f.orgId, "PARTNER")]);
  try {
    await pause.ready();
    await changeMemberRole(leader, f.projectId, editor.id, "VIEWER");
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("organisation archive after preflight denies a party addition", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addParty(editor, f.projectId, f.orgId, "PARTNER")]);
  try {
    await pause.ready();
    await db.organisation.update({ where: { id: f.orgId }, data: { archivedAt: new Date() } });
    const before = await state(f.projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 400 }) })]);
    expect(await state(f.projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Editor adds one party and action", async () => {
  const f = await fixture();
  await addParty(editor, f.projectId, f.orgId, "PARTNER");
  const after = await state(f.projectId);
  expect(after.parties.filter((p) => p.organisationId === f.orgId && p.role === "PARTNER")).toHaveLength(1);
  expect(after.actions.filter((a) => a.action === "deal.party_added")).toHaveLength(1);
});
