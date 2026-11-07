// Real PostgreSQL interleavings for comment add/remove Undo.
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

const prefix = 'undo-comment-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
const previousFlag = process.env.FF_TASK_COMMENTS;
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  process.env.FF_TASK_COMMENTS = 'true';
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
  if (previousFlag === undefined) delete process.env.FF_TASK_COMMENTS;
  else process.env.FF_TASK_COMMENTS = previousFlag;
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
    mkdirSync('test-results/undo-comment', { recursive: true });
    writeFileSync('test-results/undo-comment/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'comment-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture(kind: 'comment.added' | 'comment.removed') {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + kind } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: kind, assigneeId: leader.id, createdById: leader.id } });
  const comment = await db.comment.create({ data: { taskId: task.id, authorId: editor.id, text: kind, removedAt: kind === 'comment.removed' ? new Date() : null } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind,
    beforeState: kind === 'comment.removed' ? { commentId: comment.id } : {}, afterState: { commentId: comment.id }, createdAt: new Date(Date.now() - 2000) } });
  return { project, task, comment, action };
}
async function snapshot(projectId: string, taskId: string) {
  const [comments, actions, notices] = await Promise.all([
    db.comment.findMany({ where: { taskId }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { comments, actions, notices };
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

for (const kind of ['comment.added', 'comment.removed'] as const) {
  it(`${kind} Undo refuses an actor removed after preflight without changing comment/action/activity`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      await removeMember(leader, f.project.id, editor.id);
      const before = await snapshot(f.project.id, f.task.id);
      pause.release();
      const [result] = await pending;
      const after = await snapshot(f.project.id, f.task.id);
      const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
      const unchanged = JSON.stringify(after) === JSON.stringify(before);
      mkdirSync('test-results/undo-comment', { recursive: true });
      writeFileSync(`test-results/undo-comment/verification-${kind}.json`, JSON.stringify({ kind, actorRemoved: true, denied, unchanged, actionClaimed: (after.actions.find((x) => x.id === f.action.id)?.undoneAt ?? null) !== null }, null, 2));
      expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
      completed.push(kind + ':removed-after-preflight');
    } finally { pause.release(); await pending; }
  }, 20_000);

  it(`${kind} Undo rechecks comment state after preflight`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      await db.comment.update({ where: { id: f.comment.id }, data: { removedAt: kind === 'comment.added' ? new Date() : null } });
      const before = await snapshot(f.project.id, f.task.id); pause.release();
      expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
      expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneAt).toBeNull();
      completed.push(kind + ':state-after-preflight');
    } finally { pause.release(); await pending; }
  });

  it(`${kind} duplicate Undo has one winner, one claim and one activity row`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(2);
    const results = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
    try {
      await pause.ready(); pause.release(); const settled = await results;
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
      expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneById).toBe(editor.id);
      expect((await db.comment.findUniqueOrThrow({ where: { id: f.comment.id } })).removedAt === null).toBe(kind === 'comment.removed');
      completed.push(kind + ':duplicate-one-winner');
    } finally { pause.release(); await results; }
  });

  it(`${kind} activity failure rolls back inverse and claim; retry succeeds`, async () => {
    const f = await fixture(kind), before = await snapshot(f.project.id, f.task.id);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('COMMENT_UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(editor, f.action.id)).rejects.toThrow('COMMENT_UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks();
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    await undoAction(editor, f.action.id);
    expect((await db.comment.findUniqueOrThrow({ where: { id: f.comment.id } })).removedAt === null).toBe(kind === 'comment.removed');
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push(kind + ':activity-rollback-retry');
  });
}

it('comment restoration refuses a full 200-comment task after preflight without claiming Undo', async () => {
  const f = await fixture('comment.removed'), pause = pauseBeforeTransactions(1);
  await db.comment.createMany({ data: Array.from({ length: 199 }, (_, i) => ({ taskId: f.task.id, authorId: editor.id, text: 'live ' + i })) });
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.comment.create({ data: { taskId: f.task.id, authorId: leader.id, text: 'the 200th live comment' } });
    const before = await snapshot(f.project.id, f.task.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ code: 'too_many_comments' }) }) })]);
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('restore-cap-after-preflight');
  } finally { pause.release(); await pending; }
});

it('a comment-row lock makes Undo retryable without a partial claim', async () => {
  const f = await fixture('comment.added'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Comment" WHERE "id" = ${f.comment.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('comment-row-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.comment.findUniqueOrThrow({ where: { id: f.comment.id } })).removedAt).not.toBeNull();
});

it('Undo refuses an action whose comment belongs to a different task', async () => {
  const first = await fixture('comment.added'), second = await fixture('comment.added');
  await db.actionLog.update({ where: { id: first.action.id }, data: { afterState: { commentId: second.comment.id } } });
  const before = await snapshot(first.project.id, first.task.id);
  await expect(undoAction(editor, first.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(first.project.id, first.task.id)).toEqual(before);
  expect((await db.comment.findUniqueOrThrow({ where: { id: second.comment.id } })).removedAt).toBeNull();
  completed.push('foreign-comment-rejected');
});

it('Undo rechecks project archive after preflight before changing a comment', async () => {
  const f = await fixture('comment.added'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.project.update({ where: { id: f.project.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(f.project.id, f.task.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('archive-after-preflight');
  } finally { pause.release(); await pending; }
});

it('Undo rechecks a Viewer downgrade after preflight before restoring a comment', async () => {
  const f = await fixture('comment.removed'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.projectMember.update({ where: { projectId_userId: { projectId: f.project.id, userId: editor.id } }, data: { role: 'VIEWER' } });
    const before = await snapshot(f.project.id, f.task.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('viewer-after-preflight');
  } finally { pause.release(); await pending; }
});
