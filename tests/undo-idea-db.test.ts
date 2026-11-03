// Real PostgreSQL interleavings for task.idea_changed Undo in a disposable database.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { removeMember } from '@/lib/projects';
import { undoAction } from '@/lib/undo';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-idea-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
    users.push(actor.id);
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-idea', { recursive: true });
    writeFileSync('test-results/undo-idea/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-idea-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Idea task', assigneeId: leader.id, createdById: leader.id, isIdea: true } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: 'task.idea_changed', beforeState: { isIdea: false }, afterState: { isIdea: true }, createdAt: new Date(Date.now() - 2000) } });
  return { project, section, task, action };

}
async function snapshot(projectId: string) {
  const [tasks, actions, notices] = await Promise.all([
    db.task.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { tasks, actions, notices };
}
const transact = db.$transaction.bind(db);
function pauseBeforeTransactions(count: number) {
  let release!: () => void, arrived = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('refuses a removed actor after preflight without changing idea state or claim', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await removeMember(leader, f.project.id, editor.id);
    const before = await snapshot(f.project.id);
    pause.release();
    const [result] = await pending, after = await snapshot(f.project.id);
    const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    mkdirSync('test-results/undo-idea', { recursive: true });
    writeFileSync('test-results/undo-idea/verification.json', JSON.stringify({ actorRemoved: true, denied, unchanged, actionClaimed: after.actions.find((row) => row.id === f.action.id)?.undoneAt !== null }, null, 2));
    expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
    completed.push('removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('rejects Undo after the idea flag changes during preflight; override reverts only that flag', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.task.update({ where: { id: f.task.id }, data: { isIdea: false, priority: 'HIGH' } });
    await db.actionLog.create({ data: { actorId: leader.id, projectId: f.project.id, targetType: 'task', targetId: f.task.id, channel: 'SCREEN', action: 'task.idea_changed', beforeState: { isIdea: true }, afterState: { isIdea: false } } });
    const before = await snapshot(f.project.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'conflict' }) }) })]);
    expect(await snapshot(f.project.id)).toEqual(before);
    await undoAction(editor, f.action.id, true);
    const task = await db.task.findUniqueOrThrow({ where: { id: f.task.id } });
    expect({ isIdea: task.isIdea, priority: task.priority }).toEqual({ isIdea: false, priority: 'HIGH' });
    expect(await db.notification.count({ where: { projectId: f.project.id, recipientId: leader.id, type: 'CHANGE_OVERRIDDEN' } })).toBe(1);
    completed.push('changed-flag-conflict-override');
  } finally { pause.release(); await pending; }
});

it('does not undo an idea change after the task becomes a subtask', async () => {
  const f = await fixture();
  const parent = await db.task.create({ data: { workspaceId, projectId: f.project.id, sectionId: f.section.id, title: 'Parent', assigneeId: leader.id, createdById: leader.id } });
  await db.task.update({ where: { id: f.task.id }, data: { parentId: parent.id } });
  const before = await snapshot(f.project.id);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(f.project.id)).toEqual(before);
  completed.push('subtask-invariant');
});

it('duplicate Undo has one inverse, one claim and one activity', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).isIdea).toBe(false);
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('activity failure rolls back idea inverse and claim, then retry succeeds', async () => {
  const f = await fixture(), before = await snapshot(f.project.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('IDEA_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.action.id)).rejects.toThrow('IDEA_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(f.project.id)).toEqual(before);
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).isIdea).toBe(false);
  expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
  completed.push('activity-rollback-and-retry');
});

it('a competing membership lock returns a retryable conflict without a partial claim', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${f.project.id} AND "userId" = ${editor.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('membership-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).isIdea).toBe(false);
});

it('Undo advances a future version while preserving unrelated fields', async () => {
  const f = await fixture(), stamp = new Date(Date.now() + 60_000);
  await db.task.update({ where: { id: f.task.id }, data: { updatedAt: stamp, priority: 'HIGH' } });
  await undoAction(editor, f.action.id);
  const task = await db.task.findUniqueOrThrow({ where: { id: f.task.id } });
  expect({ isIdea: task.isIdea, priority: task.priority }).toEqual({ isIdea: false, priority: 'HIGH' });
  expect(task.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  completed.push('monotonic-version');
});

it('rechecks project archive after preflight before changing the idea', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.project.update({ where: { id: f.project.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(f.project.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('archive-after-preflight');
  } finally { pause.release(); await pending; }
});

it('rechecks a Viewer downgrade after preflight before changing the idea', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.projectMember.update({ where: { projectId_userId: { projectId: f.project.id, userId: editor.id } }, data: { role: 'VIEWER' } });
    const before = await snapshot(f.project.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('viewer-after-preflight');
  } finally { pause.release(); await pending; }
});

it('a competing task-row lock is retryable without a partial claim', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.task.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('task-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).isIdea).toBe(false);
});
