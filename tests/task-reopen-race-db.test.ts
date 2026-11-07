// Controlled task-reopen races against disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { moveTask, reopenTask } from '@/lib/tasks';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-reopen-race-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const people = [leader, editor];
const projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!safe) return;
  await db.user.updateMany({ where: { id: editor.id }, data: { deactivatedAt: null } });
  await db.projectMember.updateMany({ where: { projectId: { in: projects }, userId: editor.id }, data: { role: 'EDITOR' } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/task-reopen-race', { recursive: true });
    writeFileSync('test-results/task-reopen-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-reopen-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const todo = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const done = await db.section.create({ data: { projectId: project.id, name: 'Done', position: 1, isDone: true } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: done.id, previousSectionId: todo.id, completedAt: new Date(), title: prefix, assigneeId: editor.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id, todoId: todo.id, doneId: done.id };
}
function pauseBeforeTransactions() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('refuses reopen after the actor loses Editor rights following preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([reopenTask(editor, f.taskId)]);
  try {
    await pause.ready();
    await db.projectMember.update({ where: { projectId_userId: { projectId: f.projectId, userId: editor.id } }, data: { role: 'VIEWER' } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt).not.toBeNull();
    completed.push('downgraded-editor');
  } finally { pause.release(); await pending; }
});

it('refuses reopen after project archive following preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([reopenTask(editor, f.taskId)]);
  try {
    await pause.ready();
    await db.project.update({ where: { id: f.projectId }, data: { archivedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt).not.toBeNull();
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('refuses a duplicate reopen completed by another actor after preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([reopenTask(editor, f.taskId)]);
  try {
    await pause.ready();
    await reopenTask(leader, f.taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.reopened' } })).toBe(1);
    completed.push('duplicate-reopen');
  } finally { pause.release(); await pending; }
});

it('refuses reopen after the actor is deactivated following preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([reopenTask(editor, f.taskId)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt).not.toBeNull();
    completed.push('deactivated-actor');
  } finally { pause.release(); await pending; }
});

it('refuses reopen after a newer task edit follows preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([reopenTask(editor, f.taskId)]);
  try {
    await pause.ready();
    await db.task.update({ where: { id: f.taskId }, data: { title: 'Newer edit', updatedAt: new Date(Date.now() + 1000) } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt).not.toBeNull();
    completed.push('newer-task-edit');
  } finally { pause.release(); await pending; }
});

it('a drag from Done keeps its expected version through reopen', async () => {
  const f = await fixture(), version = (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).updatedAt.toISOString();
  const pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([moveTask(editor, f.taskId, f.todoId, version)]);
  try {
    await pause.ready();
    await db.task.update({ where: { id: f.taskId }, data: { title: 'Newer edit', updatedAt: new Date(Date.parse(version) + 1000) } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt).not.toBeNull();
    completed.push('drag-version');
  } finally { pause.release(); await pending; }
});

it('reopens an eligible task once into its previous section', async () => {
  const f = await fixture();
  await reopenTask(editor, f.taskId);
  const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect(row.completedAt).toBeNull();
  expect(row.sectionId).toBe(f.todoId);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.reopened' } })).toBe(1);
  completed.push('eligible-control');
});
