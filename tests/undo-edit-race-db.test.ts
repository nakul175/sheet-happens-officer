// Real PostgreSQL interleavings for ordinary task.updated Undo only.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import { listNotifications } from '@/lib/feed';
import { updateTask } from '@/lib/tasks';
import { archiveProject, changeMemberRole, removeMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-race-' + randomUUID();
const projects: string[] = [], users: string[] = [], completed: string[] = [];
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const transact = db.$transaction.bind(db);
let safe = false, workspaceId: string, sentinelId: string, sentinel: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
    users.push(actor.id);
  }
  sentinelId = (await fixture()).projectId; sentinel = await snapshot(sentinelId);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try { if (sentinel) expect(await snapshot(sentinelId)).toEqual(sentinel); }
  finally {
    try {
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync('test-results/undo-race', { recursive: true });
      writeFileSync('test-results/undo-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'ordinary-task-edit-undo-local-postgres', completed, cleanup }, null, 2));
    }
  }
});

async function fixture() {
  const p = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(p.id);
  await db.projectMember.createMany({ data: [{ projectId: p.id, userId: leader.id, role: 'LEADER' }, { projectId: p.id, userId: editor.id, role: 'EDITOR' }] });
  const section = await db.section.create({ data: { projectId: p.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: p.id, sectionId: section.id, title: 'Edited', assigneeId: leader.id, createdById: leader.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: p.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: 'task.updated', beforeState: { title: 'Original' }, afterState: { title: 'Edited' }, createdAt: new Date(Date.now() - 2000) } });
  return { projectId: p.id, taskId: task.id, actionId: action.id, version: task.updatedAt.toISOString() };
}
async function snapshot(projectId: string) {
  const [tasks, actions, notices] = await Promise.all([
    db.task.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { tasks, actions, notices };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function pauseBeforeTransactions(count: number) {
  const gate = latch(); let arrived = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++; await gate.promise; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); }, release: gate.release };
}

for (const scenario of ['removed', 'downgraded', 'archived'] as const) {
  it(`${scenario} after Undo preflight blocks the inverse and preserves current data/activity`, async () => {
    const f = await fixture(), pause = pauseBeforeTransactions(1);
    const result = Promise.allSettled([undoAction(editor, f.actionId)]);
    try {
      await pause.ready();
      if (scenario === 'removed') await removeMember(leader, f.projectId, editor.id);
      if (scenario === 'downgraded') await changeMemberRole(leader, f.projectId, editor.id, 'VIEWER');
      if (scenario === 'archived') await archiveProject(leader, f.projectId);
      const before = await snapshot(f.projectId); pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: scenario === 'removed' ? 404 : scenario === 'downgraded' ? 403 : 409 }) })]);
      expect(await snapshot(f.projectId)).toEqual(before);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.actionId } })).undoneAt).toBeNull();
      completed.push(scenario);
    } finally { pause.release(); await result; }
  });
}

it('a later edit requires confirmation; explicit override preserves unrelated fields and records its notice/audit', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const result = Promise.allSettled([undoAction(editor, f.actionId)]);
  try {
    await pause.ready();
    await updateTask(leader, f.taskId, { title: 'Newer', priority: 'HIGH', expectedUpdatedAt: f.version });
    const unrelated = await db.notification.create({ data: {
      recipientId: leader.id, projectId: f.projectId, type: 'TASK_ASSIGNED',
      taskId: f.taskId, data: { title: 'Unrelated notice' },
    } });
    const beforeBell = await listNotifications(leader);
    expect(beforeBell.items.find((item) => item.id === unrelated.id)).toMatchObject({ read: false });
    expect(beforeBell.items.some((item) => item.text.includes('replaced your change'))).toBe(false);
    const before = await snapshot(f.projectId); pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'conflict' }) }) })]);
    expect(await snapshot(f.projectId)).toEqual(before);
    expect(await undoAction(editor, f.actionId, true)).toMatchObject({ overrode: true });
    const after = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(after.title).toBe('Original'); expect(after.priority).toBe('HIGH');
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.tasks[0].updatedAt.getTime());
    expect(await db.notification.count({ where: { projectId: f.projectId, recipientId: leader.id, type: 'CHANGE_OVERRIDDEN' } })).toBe(1);
    const afterBell = await listNotifications(leader);
    const compensation = afterBell.items.filter((item) => item.text.includes('replaced your change'));
    expect(compensation).toHaveLength(1);
    expect(compensation[0]).toMatchObject({ href: `/tasks/${f.taskId}`, read: false });
    expect(afterBell.items.find((item) => item.id === unrelated.id)).toEqual(beforeBell.items.find((item) => item.id === unrelated.id));
    await expect(undoAction(editor, f.actionId, true)).rejects.toMatchObject({ status: 409 });
    expect((await listNotifications(leader)).items).toEqual(afterBell.items);
    expect(await db.auditLog.count({ where: { targetId: f.taskId, event: 'UNDO_OVERRIDE' } })).toBe(1);
    mkdirSync('test-results/undo-race', { recursive: true });
    writeFileSync('test-results/undo-race/notification-compensation.json', JSON.stringify({ fixture: prefix, projectId: f.projectId, recipientId: leader.id, unrelatedNoticeId: unrelated.id, compensationNoticeId: compensation[0].id, recipientBefore: beforeBell.items.length, recipientAfter: afterBell.items.length, compensationCount: compensation.length, replayRejected: true, unrelatedUnchanged: true }, null, 2));
    completed.push('conflict-and-explicit-override');
  } finally { pause.release(); await result; }
});

it('two simultaneous attempts apply one inverse and write exactly one Undo activity row', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const results = Promise.allSettled([undoAction(editor, f.actionId), undoAction(editor, f.actionId)]);
  try {
    await pause.ready(); pause.release(); const settled = await results;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).title).toBe('Original');
    expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'undo' } })).toBe(1);
    expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.actionId } })).undoneById).toBe(editor.id);
    completed.push('duplicate-undo');
  } finally { pause.release(); await results; }
});

it('a failure after claiming the action rolls back the claim and allows a clean retry', async () => {
  const f = await fixture(), before = await snapshot(f.projectId);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('SYNTHETIC_UNDO_AUDIT_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.actionId)).rejects.toThrow('SYNTHETIC_UNDO_AUDIT_FAILURE');
  vi.restoreAllMocks(); expect(await snapshot(f.projectId)).toEqual(before);
  await undoAction(editor, f.actionId);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).title).toBe('Original');
  expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'undo' } })).toBe(1);
  completed.push('claim-rollback-and-retry');
});

it('a competing membership lock returns409 without waiting in a reverse lock order', async () => {
  const f = await fixture(), gate = latch(); let locked = false;
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${f.projectId} AND "userId" = ${editor.id} FOR UPDATE`;
    locked = true; await gate.promise;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.projectId);
    await expect(undoAction(editor, f.actionId)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.projectId)).toEqual(before);
    completed.push('membership-lock-conflict');
  } finally { gate.release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
});
