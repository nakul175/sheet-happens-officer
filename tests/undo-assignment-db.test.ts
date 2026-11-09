// Real PostgreSQL interleavings for assignment/approval Undo; disposable local fixture only.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import { addComment } from '@/lib/comments';
import { archiveProject, changeMemberRole, removeMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-assignment-' + randomUUID();
const projects: string[] = [], users: string[] = [], completed: string[] = [];
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const previous = { id: prefix + '-previous', orgRole: 'MEMBER' as const };
const kinds = ['task.assigned', 'task.sent_for_approval', 'task.sent_back', 'task.approver_changed'];
const transact = db.$transaction.bind(db);
let safe = false, workspaceId: string, sentinelId: string, sentinel: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor, previous]) {
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
      mkdirSync('test-results/undo-assignment', { recursive: true });
      writeFileSync('test-results/undo-assignment/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'assignment-approval-undo-local-postgres', completed, cleanup }, null, 2));
    }
  }
});

async function fixture(kind = 'task.assigned') {
  const p = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(p.id);
  await db.projectMember.createMany({ data: [{ projectId: p.id, userId: leader.id, role: 'LEADER' }, { projectId: p.id, userId: editor.id, role: 'EDITOR' }, { projectId: p.id, userId: previous.id, role: 'EDITOR' }] });
  const section = await db.section.create({ data: { projectId: p.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: p.id, sectionId: section.id, title: 'Assignment control', assigneeId: leader.id, approverId: kind === 'task.sent_for_approval' ? leader.id : null, previousAssigneeId: kind === 'task.sent_for_approval' ? previous.id : null, createdById: leader.id } });
  // A send-back clears the approver only when it falls back to that same Leader.
  const restoredPerson = kind === 'task.sent_back' ? leader.id : previous.id;
  const before = kind === 'task.approver_changed' ? { approverId: previous.id } : { assigneeId: restoredPerson, previousAssigneeId: null, ...(kind === 'task.sent_back' ? { approverId: leader.id } : {}) };
  const after = kind === 'task.approver_changed' ? { approverId: null } : { assigneeId: leader.id, ...(kind === 'task.sent_back' ? { approverId: null } : {}) };
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: p.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind, beforeState: before, afterState: after, createdAt: new Date(Date.now() - 2000) } });
  return { projectId: p.id, taskId: task.id, actionId: action.id, version: task.updatedAt.toISOString(), kind, restoredPerson };
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

for (const kind of kinds) {
  it(`${kind}: later assignment requires confirmation and explicit override preserves other fields`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const result = Promise.allSettled([undoAction(editor, f.actionId)]);
    try {
      await pause.ready();
      const changed = kind === 'task.approver_changed' ? { approverId: editor.id } : { assigneeId: editor.id };
      await db.task.update({ where: { id: f.taskId }, data: { ...changed, priority: 'HIGH' } });
      await db.actionLog.create({ data: { actorId: leader.id, projectId: f.projectId, targetType: 'task', targetId: f.taskId, channel: 'SCREEN', action: kind, beforeState: {}, afterState: changed } });
      const before = await snapshot(f.projectId); pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'conflict' }) }) })]);
      expect(await snapshot(f.projectId)).toEqual(before);
      expect(await undoAction(editor, f.actionId, true)).toMatchObject({ overrode: true });
      const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
      expect(kind === 'task.approver_changed' ? task.approverId : task.assigneeId).toBe(f.restoredPerson);
      expect(task.priority).toBe('HIGH'); expect(task.updatedAt.getTime()).toBeGreaterThan(before.tasks[0].updatedAt.getTime());
      expect(await db.notification.count({ where: { projectId: f.projectId, recipientId: leader.id, type: 'CHANGE_OVERRIDDEN' } })).toBe(1);
      expect(await db.auditLog.count({ where: { targetId: f.taskId, event: 'UNDO_OVERRIDE' } })).toBe(1);
      completed.push(kind + ':conflict-override');
    } finally { pause.release(); await result; }
  });
  it(`${kind}: duplicate concurrent Undo has one winner and one activity`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(2);
    const results = Promise.allSettled([undoAction(editor, f.actionId), undoAction(editor, f.actionId)]);
    try {
      await pause.ready(); pause.release(); const settled = await results;
      expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter(r => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
      expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'undo' } })).toBe(1);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.actionId } })).undoneById).toBe(editor.id);
      completed.push(kind + ':duplicate');
    } finally { pause.release(); await results; }
  });
  it(`${kind}: activity failure rolls back the inverse and claim; retry succeeds`, async () => {
    const f = await fixture(kind), before = await snapshot(f.projectId);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('ASSIGNMENT_UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(editor, f.actionId)).rejects.toThrow('ASSIGNMENT_UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks(); expect(await snapshot(f.projectId)).toEqual(before);
    await undoAction(editor, f.actionId);
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(kind === 'task.approver_changed' ? task.approverId : task.assigneeId).toBe(f.restoredPerson);
    if (kind === 'task.sent_back') { expect(task.approverId).toBe(leader.id); expect(task.previousAssigneeId).toBeNull(); }
    expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'undo' } })).toBe(1);
    completed.push(kind + ':rollback-retry');
  });
}
for (const scenario of ['removed', 'downgraded', 'archived'] as const) {
  it(`${scenario} actor/project after preflight blocks assignment Undo with unchanged state`, async () => {
    const f = await fixture(), pause = pauseBeforeTransactions(1), result = Promise.allSettled([undoAction(editor, f.actionId)]);
    try {
      await pause.ready();
      if (scenario === 'removed') await removeMember(leader, f.projectId, editor.id);
      if (scenario === 'downgraded') await changeMemberRole(leader, f.projectId, editor.id, 'VIEWER');
      if (scenario === 'archived') await archiveProject(leader, f.projectId);
      const before = await snapshot(f.projectId); pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: scenario === 'removed' ? 404 : scenario === 'downgraded' ? 403 : 409 }) })]);
      expect(await snapshot(f.projectId)).toEqual(before); completed.push(scenario);
    } finally { pause.release(); await result; }
  });
}
for (const kind of ['task.assigned', 'task.approver_changed']) {
  it(`${kind}: previous person removed before Undo is rejected and leaves no claim`, async () => {
    const f = await fixture(kind); await removeMember(leader, f.projectId, previous.id);
    const before = await snapshot(f.projectId);
    await expect(undoAction(editor, f.actionId)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.projectId)).toEqual(before); completed.push(kind + ':previous-person-removed');
  });
}
it('assignment Undo does not restore a departed previous assignee as a comment recipient', async () => {
  const f = await fixture('task.sent_for_approval');
  await db.actionLog.update({ where: { id: f.actionId }, data: {
    beforeState: { assigneeId: leader.id, previousAssigneeId: previous.id },
  } });
  await removeMember(leader, f.projectId, previous.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).previousAssigneeId).toBeNull();
  await undoAction(editor, f.actionId);
  const originalFlag = process.env.FF_TASK_COMMENTS;
  process.env.FF_TASK_COMMENTS = 'true';
  try { await addComment(editor, f.taskId, { text: 'Approval update' }); }
  finally {
    if (originalFlag === undefined) delete process.env.FF_TASK_COMMENTS;
    else process.env.FF_TASK_COMMENTS = originalFlag;
  }
  expect(await db.notification.count({ where: {
    projectId: f.projectId, taskId: f.taskId, recipientId: previous.id, type: 'COMMENT_ADDED',
  } })).toBe(0);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).previousAssigneeId).toBeNull();
  completed.push('departed-previous-assignee-notice');
});
it('an assignment Undo advances a future task version instead of moving it backwards', async () => {
  const f = await fixture(), stamp = new Date(Date.now() + 60_000);
  await db.task.update({ where: { id: f.taskId }, data: { updatedAt: stamp } });
  await undoAction(editor, f.actionId);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  completed.push('monotonic-version');
});
