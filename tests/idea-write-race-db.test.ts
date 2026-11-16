// Direct idea writes versus project membership changes on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { setIdea } from "@/lib/tasks";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `idea-write-race-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
const projects: string[] = [];
let workspaceId = "";
let safe = false;
let sentinel: { id: string; title: string; updatedAt: Date };
const transact = db.$transaction.bind(db);

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: "To do", position: 0 } });
  const task = await db.task.create({ data: {
    workspaceId, projectId: project.id, sectionId: section.id,
    title: "Idea write race", assigneeId: leader.id, createdById: leader.id,
  } });
  return { projectId: project.id, taskId: task.id };
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

async function state(taskId: string) {
  const [task, actions, notices] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: taskId }, select: { isIdea: true, updatedAt: true } }),
    db.actionLog.findMany({ where: { targetId: taskId, action: "task.idea_changed" }, orderBy: { id: "asc" } }),
    db.notification.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
  ]);
  return { task, actions, notices };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of [leader, editor]) {
    await db.user.create({ data: {
      id: person.id, workspaceId, name: person.id, email: `${person.id}@example.invalid`,
      passwordHash: "unused", emailVerifiedAt: new Date(),
    } });
  }
  const row = await fixture();
  sentinel = await db.task.findUniqueOrThrow({ where: { id: row.taskId }, select: { id: true, title: true, updatedAt: true } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect(await db.task.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, title: true, updatedAt: true } })).toEqual(sentinel);
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
      mkdirSync("test-results/idea-write-race", { recursive: true });
      writeFileSync("test-results/idea-write-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, people: 2 }, null, 2));
    }
  }
});

it("removal committed after preflight denies a direct idea write", async () => {
  const { projectId, taskId } = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([setIdea(editor, taskId, true)]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, editor.id);
    const before = await state(taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(taskId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("Viewer downgrade committed after preflight denies a direct idea write", async () => {
  const { projectId, taskId } = await fixture();
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([setIdea(editor, taskId, true)]);
  try {
    await pause.ready();
    await changeMemberRole(leader, projectId, editor.id, "VIEWER");
    const before = await state(taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(taskId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Editor changes the idea flag and records the correct inverse", async () => {
  const { taskId } = await fixture();
  await setIdea(editor, taskId, true);
  const after = await state(taskId);
  expect(after.task.isIdea).toBe(true);
  expect(after.actions).toHaveLength(1);
  expect(after.actions[0]?.beforeState).toEqual({ isIdea: false });
  expect(after.actions[0]?.afterState).toEqual({ isIdea: true });
});
