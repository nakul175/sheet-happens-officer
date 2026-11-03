// Real PostgreSQL interleavings for project management Undo.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import { changeLeader, unarchiveProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-management-' + randomUUID();
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
      mkdirSync('test-results/undo-management', { recursive: true });
      writeFileSync('test-results/undo-trash/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'management-undo-local-postgres', completed, cleanup }, null, 2));
    }
  }
});

async function fixture(actionActor = editor, kind = 'project.archived', currentActorRole: 'LEADER' | 'EDITOR' = 'LEADER') {
  const p = await db.project.create({ data: { workspaceId, name: 'Updated project', archivedAt: kind === 'project.archived' ? new Date() : null } }); projects.push(p.id);
  await db.projectMember.createMany({ data: [{ projectId: p.id, userId: leader.id, role: actionActor.id === leader.id || currentActorRole === 'EDITOR' ? 'LEADER' : 'EDITOR' }, { projectId: p.id, userId: editor.id, role: actionActor.id === editor.id && currentActorRole === 'LEADER' ? 'LEADER' : 'EDITOR' }] });
  const action = await db.actionLog.create({ data: { actorId: actionActor.id, projectId: p.id, targetType: 'project', targetId: p.id, channel: 'SCREEN', action: kind, beforeState: kind === 'project.updated' ? { name: 'Old project' } : { archivedAt: null }, afterState: kind === 'project.updated' ? { name: 'Updated project' } : { archivedAt: p.archivedAt?.toISOString() }, createdAt: new Date(Date.now() - 2000) } });
  return { projectId: p.id, actionId: action.id };
}
async function snapshot(projectId: string) {
  const [project, members, actions, notices] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId } }),
    db.projectMember.findMany({ where: { projectId }, orderBy: { userId: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { project, members, actions, notices };
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
it('a former Leader who is now an Editor cannot use Undo to unarchive a project', async () => {
  const f = await fixture(editor, 'project.archived', 'EDITOR');
  await expect(unarchiveProject(editor, f.projectId)).rejects.toMatchObject({ status: 403 });
  const before = await snapshot(f.projectId);
  await expect(undoAction(editor, f.actionId)).rejects.toMatchObject({ status: 403 });
  expect(await snapshot(f.projectId)).toEqual(before); completed.push('former-leader-denied');
});
it('losing Leader rights after preflight blocks the inverse and leaves current state unchanged', async () => {
  const f = await fixture(editor, 'project.updated'), pause = pauseBeforeTransactions(1);
  const result = Promise.allSettled([undoAction(editor, f.actionId)]);
  try {
    await pause.ready(); await changeLeader(editor, f.projectId, { newLeaderId: leader.id, previousRole: 'EDITOR' });
    const before = await snapshot(f.projectId); pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.projectId)).toEqual(before); completed.push('leader-downgraded-after-preflight');
  } finally { pause.release(); await result; }
});
it('two concurrent Leader Undo requests have one winner and one activity record', async () => {
  const f = await fixture(leader), pause = pauseBeforeTransactions(2);
  const results = Promise.allSettled([undoAction(leader, f.actionId), undoAction(leader, f.actionId)]);
  try {
    await pause.ready(); pause.release(); const settled = await results;
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(r => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const after = await snapshot(f.projectId);
    expect(after.project.archivedAt).toBeNull(); expect(after.actions.filter(a => a.action === 'undo')).toHaveLength(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await results; }
});
it('activity failure rolls back management inverse and claim, then retry succeeds', async () => {
  const f = await fixture(leader), before = await snapshot(f.projectId);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('MANAGEMENT_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(leader, f.actionId)).rejects.toThrow('MANAGEMENT_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks(); expect(await snapshot(f.projectId)).toEqual(before);
  await undoAction(leader, f.actionId);
  const after = await snapshot(f.projectId);
  expect(after.project.archivedAt).toBeNull(); expect(after.actions.filter(a => a.action === 'undo')).toHaveLength(1);
  completed.push('rollback-retry');
});
