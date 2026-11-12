// Direct deal-detail writes versus project membership changes on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { updateDealDetails } from "@/lib/deals";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-details-write-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
const projects: string[] = [];
let workspaceId = "";
let safe = false;
let pipelineId = "";
let sentinel: { id: string; name: string };
const transact = db.$transaction.bind(db);

async function fixture() {
  const project = await db.project.create({ data: {
    workspaceId, name: prefix, typeId: "wst_deal", pipelineId,
  } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
  ] });
  await db.dealDetails.create({ data: { projectId: project.id, workspaceId, whyPursue: "Before" } });
  return project.id;
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
  const [project, details, actions] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId } }),
    db.dealDetails.findUniqueOrThrow({ where: { projectId } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
  ]);
  return { project, details, actions };
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
      await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, editor.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/deal-details-write-race", { recursive: true });
      writeFileSync("test-results/deal-details-write-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, people: 2 }, null, 2));
    }
  }
});

it("removal committed after preflight denies a direct detail edit", async () => {
  const projectId = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateDealDetails(editor, projectId, { whyPursue: "After" })]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, editor.id);
    const before = await state(projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("Viewer downgrade committed after preflight denies a direct detail edit", async () => {
  const projectId = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateDealDetails(editor, projectId, { whyPursue: "After" })]);
  try {
    await pause.ready();
    await changeMemberRole(leader, projectId, editor.id, "VIEWER");
    const before = await state(projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Editor edits details once and records one action", async () => {
  const projectId = await fixture();
  await updateDealDetails(editor, projectId, { whyPursue: "After" });
  const after = await state(projectId);
  expect(after.details.whyPursue).toBe("After");
  expect(after.actions.filter((a) => a.action === "deal.details_updated")).toHaveLength(1);
});
