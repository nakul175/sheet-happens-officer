// Direct deal-stage writes versus project membership changes on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { moveStage } from "@/lib/deals";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `deal-stage-write-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
const projects: string[] = [];
let workspaceId = "";
let safe = false;
let pipelineId = "";
let initialId = "";
let targetId = "";
let sentinel: { id: string; name: string };
const transact = db.$transaction.bind(db);

async function fixture() {
  const project = await db.project.create({ data: {
    workspaceId, name: prefix, typeId: "wst_deal", pipelineId,
    stageId: initialId, stageChangedAt: new Date(),
  } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
  ] });
  await db.dealDetails.create({ data: { projectId: project.id, workspaceId, whyPursue: "Owned stage race" } });
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
  const [project, details, actions, notices] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId } }),
    db.dealDetails.findUniqueOrThrow({ where: { projectId } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
  ]);
  return { project, details, actions, notices };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: "DEAL_PROACTIVE" }, include: { stages: { where: { isRetired: false }, orderBy: { position: "asc" } } } });
  if (!pipeline || pipeline.stages.length < 2 || pipeline.stages[0]?.requiredFields.length || pipeline.stages[1]?.requiredFields.length) {
    throw new Error("Disposable proactive stage seed is incomplete.");
  }
  pipelineId = pipeline.id;
  initialId = pipeline.stages[0].id;
  targetId = pipeline.stages[1].id;
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
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, editor.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/deal-stage-write-race", { recursive: true });
      writeFileSync("test-results/deal-stage-write-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, people: 2 }, null, 2));
    }
  }
});

it("removal committed after preflight denies a direct stage move", async () => {
  const projectId = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([moveStage(editor, projectId, { stageId: targetId, expectedStageId: initialId })]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, editor.id);
    const before = await state(projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("Viewer downgrade committed after preflight denies a direct stage move", async () => {
  const projectId = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([moveStage(editor, projectId, { stageId: targetId, expectedStageId: initialId })]);
  try {
    await pause.ready();
    await changeMemberRole(leader, projectId, editor.id, "VIEWER");
    const before = await state(projectId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(projectId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Editor moves a deal once and records one stage action", async () => {
  const projectId = await fixture();
  await moveStage(editor, projectId, { stageId: targetId, expectedStageId: initialId });
  const after = await state(projectId);
  expect(after.project.stageId).toBe(targetId);
  expect(after.actions.filter((a) => a.action === "deal.stage_changed")).toHaveLength(1);
});
