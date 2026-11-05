// Restoration must recheck authority and parent/task state after preflight.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { archiveProject } from '@/lib/projects';
import { deleteTask, restoreTask } from '@/lib/tasks';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-restore-stale-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const people = [leader, admin], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterEach(async () => { vi.restoreAllMocks(); if (safe) await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } }); });
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/task-restore-stale-race', { recursive: true });
    writeFileSync('test-results/task-restore-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-restore-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(child = false) {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.create({ data: { projectId: project.id, userId: leader.id, role: 'LEADER' } });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const at = new Date();
  const parent = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: prefix, assigneeId: leader.id, createdById: leader.id, deletedAt: child ? null : at } });
  const task = child ? await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, parentId: parent.id, title: prefix + '-child', assigneeId: leader.id, createdById: leader.id, deletedAt: at } }) : parent;
  return { projectId: project.id, parentId: parent.id, taskId: task.id };
}
function pauseBeforeTransaction() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects an Admin whose organisation role was revoked after preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([restoreTask(admin, f.taskId)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).not.toBeNull();
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects restoration after project archive following preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([restoreTask(leader, f.taskId)]);
  try {
    await pause.ready(); await archiveProject(leader, f.projectId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).not.toBeNull();
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('rejects a duplicate restoration completed after preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([restoreTask(leader, f.taskId)]);
  try {
    await pause.ready(); await restoreTask(leader, f.taskId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'task.restored' } })).toBe(1);
    completed.push('duplicate-restore');
  } finally { pause.release(); await pending; }
});

it('requires confirmation when the child parent is deleted after preflight', async () => {
  const f = await fixture(true), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([restoreTask(leader, f.taskId)]);
  try {
    await pause.ready(); await deleteTask(leader, f.parentId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'parent' }) }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).not.toBeNull();
    completed.push('parent-deleted');
  } finally { pause.release(); await pending; }
});

it('restores an eligible deleted task once', async () => {
  const f = await fixture(); await restoreTask(leader, f.taskId);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).toBeNull();
  expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'task.restored' } })).toBe(1);
  completed.push('eligible-control');
});
