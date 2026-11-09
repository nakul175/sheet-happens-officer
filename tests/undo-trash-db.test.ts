// Real PostgreSQL interleavings for task creation/deletion/restoration Undo.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import { deleteTask, purgeTrash, restoreTask } from '@/lib/tasks';
import { addComment } from '@/lib/comments';
import { UNDO_WINDOW_MS } from '@/lib/undoable';
import { removeMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-trash-' + randomUUID();
const projects: string[] = [], users: string[] = [], completed: string[] = [], purgeAuditIds: string[] = [];
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
      await db.auditLog.deleteMany({ where: { id: { in: purgeAuditIds } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      expect(await db.auditLog.count({ where: { id: { in: purgeAuditIds } } })).toBe(0);
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync('test-results/undo-trash', { recursive: true });
      writeFileSync('test-results/undo-trash/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-trash-undo-local-postgres', completed, purgeAuditRows: purgeAuditIds.length, cleanup }, null, 2));
    }
  }
});

async function fixture(kind = 'task.deleted') {
  const p = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(p.id);
  await db.projectMember.createMany({ data: [{ projectId: p.id, userId: leader.id, role: 'LEADER' }, { projectId: p.id, userId: editor.id, role: 'EDITOR' }] });
  const section = await db.section.create({ data: { projectId: p.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: p.id, sectionId: section.id, title: 'Trash control', deletedAt: kind === 'task.deleted' ? new Date() : null, assigneeId: leader.id, createdById: leader.id } });
  const action = await db.actionLog.create({ data: { actorId: leader.id, projectId: p.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind, beforeState: {}, afterState: {}, createdAt: new Date(Date.now() - 2000) } });
  await db.task.create({ data: { workspaceId, projectId: p.id, sectionId: section.id, parentId: task.id, title: 'Child cohort', assigneeId: leader.id, createdById: leader.id, deletedAt: task.deletedAt } });
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


for (const kind of ['task.deleted', 'task.created', 'task.restored']) {
  it(`${kind}: activity failure rolls back parent/child inverse and claim, then retry succeeds`, async () => {
    const f = await fixture(kind);
    if (kind === 'task.deleted') {
      await db.task.update({ where: { id: f.taskId }, data: { assigneeId: editor.id } });
      await removeMember(leader, f.projectId, editor.id);
    }
    const before = await snapshot(f.projectId);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(leader, f.actionId)).rejects.toThrow('UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks(); expect(await snapshot(f.projectId)).toEqual(before);
    await undoAction(leader, f.actionId);
    const after = await snapshot(f.projectId);
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks.every(t => kind === 'task.deleted' ? t.deletedAt === null : t.deletedAt !== null)).toBe(true);
    expect(after.actions.filter(a => a.action === 'undo')).toHaveLength(1);
    expect(after.actions.find(a => a.id === f.actionId)?.undoneById).toBe(leader.id);
    completed.push(kind + ':rollback-retry');
  });
  it(`${kind}: concurrent Undo applies once`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(2);
    const results = Promise.allSettled([undoAction(leader, f.actionId), undoAction(leader, f.actionId)]);
    try {
      await pause.ready(); pause.release(); const settled = await results;
      expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter(r => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
      expect((await snapshot(f.projectId)).actions.filter(a => a.action === 'undo')).toHaveLength(1);
      completed.push(kind + ':duplicate');
    } finally { pause.release(); await results; }
  });
}
it('removed actor cannot undo task creation after preflight', async () => {
  const f = await fixture('task.created');
  await db.actionLog.update({ where: { id: f.actionId }, data: { actorId: editor.id } });
  const pause = pauseBeforeTransactions(1), result = Promise.allSettled([undoAction(editor, f.actionId)]);
  try {
    await pause.ready(); await removeMember(leader, f.projectId, editor.id);
    const before = await snapshot(f.projectId); pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(f.projectId)).toEqual(before); completed.push('removed-after-preflight');
  } finally { pause.release(); await result; }
});
it('task deletion Undo restores trashed work to the Leader after its assignee leaves during preflight', async () => {
  const f = await fixture('task.deleted');
  await db.task.updateMany({ where: { projectId: f.projectId }, data: { assigneeId: editor.id } });
  const pause = pauseBeforeTransactions(1);
  const result = Promise.allSettled([undoAction(leader, f.actionId)]);
  try {
    await pause.ready();
    await removeMember(leader, f.projectId, editor.id);
    const before = await db.task.findMany({ where: { projectId: f.projectId } });
    expect(before).toHaveLength(2);
    expect(before.every(t => t.deletedAt && t.assigneeId === editor.id)).toBe(true);
    pause.release();
    expect((await result)[0].status).toBe('fulfilled');
    const after = await snapshot(f.projectId);
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks.every(t => !t.deletedAt && t.assigneeId === leader.id)).toBe(true);
    expect(after.actions.filter(a => a.action === 'undo')).toHaveLength(1);
    expect(after.actions.find(a => a.id === f.actionId)?.undoneById).toBe(leader.id);
    completed.push('recipient-removed-after-preflight');
  } finally { pause.release(); await result; }
});
it('a comment paused before its write cannot attach to a deleted task or reappear after Undo', async () => {
  const originalFlag = process.env.FF_TASK_COMMENTS;
  process.env.FF_TASK_COMMENTS = 'true';
  const f = await fixture('task.created');
  const pause = pauseBeforeTransactions(1);
  const result = Promise.allSettled([addComment(editor, f.taskId, { text: 'Should not attach after deletion' })]);
  try {
    await pause.ready();
    await deleteTask(leader, f.taskId);
    const deleted = await db.actionLog.findFirstOrThrow({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.deleted' } });
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.comment.count({ where: { taskId: f.taskId } })).toBe(0);
    await undoAction(leader, deleted.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).toBeNull();
    expect(await db.comment.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await db.actionLog.count({ where: { targetId: f.taskId, action: 'comment.added' } })).toBe(0);
    completed.push('comment-after-delete-denied');
  } finally {
    pause.release(); await result;
    if (originalFlag === undefined) delete process.env.FF_TASK_COMMENTS;
    else process.env.FF_TASK_COMMENTS = originalFlag;
  }
});
it('a comment committed before task deletion remains after deletion Undo', async () => {
  const originalFlag = process.env.FF_TASK_COMMENTS;
  process.env.FF_TASK_COMMENTS = 'true';
  const f = await fixture('task.created');
  const release = latch();
  let afterWrite = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) =>
    transact(async (tx) => {
      const value = await callback(tx);
      afterWrite = true;
      await release.promise; // The comment and its action exist but are not committed yet.
      return value;
    }, options)) as typeof db.$transaction);
  const addition = addComment(editor, f.taskId, { text: 'Committed before the task went to Trash' });
  let deletion: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(afterWrite).toBe(true), { timeout: 5000 });
    spy.mockRestore();
    await expect(db.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.taskId} FOR UPDATE NOWAIT`).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
    deletion = deleteTask(leader, f.taskId);
    release.release();
    const comment = await addition;
    await deletion;
    const deleted = await db.actionLog.findFirstOrThrow({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.deleted' } });
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).not.toBeNull();
    await undoAction(leader, deleted.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).deletedAt).toBeNull();
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).removedAt).toBeNull();
    expect(await db.actionLog.count({ where: { targetId: f.taskId, action: 'comment.added' } })).toBe(1);
    completed.push('comment-before-delete-preserved');
  } finally {
    spy.mockRestore(); release.release();
    await Promise.allSettled([addition, ...(deletion ? [deletion] : [])]);
    if (originalFlag === undefined) delete process.env.FF_TASK_COMMENTS;
    else process.env.FF_TASK_COMMENTS = originalFlag;
  }
});
it('direct delete and restore still work with their own transactions', async () => {
  const f = await fixture('task.created');
  await deleteTask(leader, f.taskId);
  expect((await snapshot(f.projectId)).tasks.every(t => t.deletedAt !== null)).toBe(true);
  await restoreTask(leader, f.taskId);
  expect((await snapshot(f.projectId)).tasks.every(t => t.deletedAt === null)).toBe(true);
  completed.push('direct-services');
});

it('a physically purged parent and child cannot be resurrected by their retained delete action', async () => {
  const f = await fixture('task.deleted');
  const now = new Date();
  const expired = new Date(now.getTime() - UNDO_WINDOW_MS - 1000);
  await db.task.updateMany({ where: { projectId: f.projectId }, data: { deletedAt: expired } });
  await db.actionLog.update({ where: { id: f.actionId }, data: { createdAt: expired } });
  const createAudit = db.auditLog.create.bind(db.auditLog);
  vi.spyOn(db.auditLog, 'create').mockImplementationOnce((async (args: Parameters<typeof db.auditLog.create>[0]) => {
    const row = await createAudit(args);
    purgeAuditIds.push(row.id);
    return row;
  }) as unknown as typeof db.auditLog.create);
  expect(await purgeTrash(now, { id: f.taskId })).toBe(1);
  expect(purgeAuditIds).toHaveLength(1);
  expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
  const action = await db.actionLog.findUniqueOrThrow({ where: { id: f.actionId } });
  expect(action.undoneAt).toBeNull();
  await expect(undoAction(leader, f.actionId)).rejects.toMatchObject({ status: 409 });
  expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'undo' } })).toBe(0);
  expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.actionId } })).undoneAt).toBeNull();
  completed.push('purged-delete-not-resurrected');
});

it('restoring a deleted child restores its parent cohort atomically but leaves an older deletion in Trash', async () => {
  const f = await fixture();
  const parent = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  const child = await db.task.findFirstOrThrow({ where: { parentId: f.taskId } });
  const older = await db.task.create({ data: { workspaceId, projectId: f.projectId, sectionId: parent.sectionId, parentId: parent.id, title: 'Earlier independent deletion', assigneeId: leader.id, createdById: leader.id, deletedAt: new Date(parent.deletedAt!.getTime() - 10_000) } });
  await db.actionLog.update({ where: { id: f.actionId }, data: { targetId: child.id } });
  await undoAction(leader, f.actionId);
  expect((await db.task.findUniqueOrThrow({ where: { id: parent.id } })).deletedAt).toBeNull();
  expect((await db.task.findUniqueOrThrow({ where: { id: child.id } })).deletedAt).toBeNull();
  expect((await db.task.findUniqueOrThrow({ where: { id: older.id } })).deletedAt).toEqual(older.deletedAt);
  completed.push('parent-cohort');
});
