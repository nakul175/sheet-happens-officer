// Real PostgreSQL interleavings for task.completed and task.reopened Undo.
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

const prefix = 'undo-completion-' + randomUUID();
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
    mkdirSync('test-results/undo-completion', { recursive: true });
    writeFileSync('test-results/undo-completion/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'completion-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture(kind: 'task.completed' | 'task.reopened') {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + kind } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const todo = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const done = await db.section.create({ data: { projectId: project.id, name: 'Done', position: 1, isDone: true } });
  const completedAt = new Date(Date.now() - 5000);
  const completed = kind === 'task.completed';
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: completed ? done.id : todo.id, title: kind, assigneeId: leader.id, createdById: leader.id, completedAt: completed ? completedAt : null } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind,
    beforeState: completed ? { completedAt: null, sectionId: todo.id, previousSectionId: null } : { completedAt, sectionId: done.id },
    afterState: completed ? { completedAt, sectionId: done.id } : { completedAt: null, sectionId: todo.id },
    createdAt: new Date(Date.now() - 2000) } });
  return { project, task, action, todo, done, completedAt };
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

for (const kind of ['task.completed', 'task.reopened'] as const) {
  it(`${kind} Undo refuses an actor removed after preflight without changing task/action/activity`, async () => {
    const f = await fixture(kind);
    let reached!: () => void, release!: () => void;
    const atTransaction = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
      reached(); await held; return transact(callback, options);
    }) as typeof db.$transaction);
    const pending = undoAction(editor, f.action.id);
    let before: Awaited<ReturnType<typeof snapshot>>;
    let safetyExpired = false;
    const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
    try {
      await Promise.race([atTransaction, pending.then(() => { throw Error('Undo passed the expected transaction gate.'); })]);
      intercepted.mockRestore();
      await removeMember(leader, f.project.id, editor.id);
      before = await snapshot(f.project.id);
    } finally {
      clearTimeout(safety); release(); intercepted.mockRestore();
    }
    const result = await Promise.allSettled([pending]);
    const after = await snapshot(f.project.id);
    const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before!);
    mkdirSync('test-results/undo-completion', { recursive: true });
    writeFileSync(`test-results/undo-completion/verification-${kind}.json`, JSON.stringify({ kind, actorRemoved: true, denied, unchanged, actionClaimed: (after.actions.find((x) => x.id === f.action.id)?.undoneAt ?? null) !== null, taskCompleted: after.tasks[0].completedAt !== null, safetyExpired }, null, 2));
    expect({ denied, unchanged, safetyExpired }).toEqual({ denied: true, unchanged: true, safetyExpired: false });
    completed.push(kind + ':removed-after-preflight');
  }, 20_000);

  it(`${kind} Undo rechecks task state after preflight before claiming the action`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const result = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      await db.task.update({ where: { id: f.task.id }, data: kind === 'task.completed'
        ? { completedAt: null, sectionId: f.todo.id }
        : { completedAt: new Date(), sectionId: f.done.id } });
      const before = await snapshot(f.project.id); pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
      expect(await snapshot(f.project.id)).toEqual(before);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneAt).toBeNull();
      completed.push(kind + ':state-after-preflight');
    } finally { pause.release(); await result; }
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
      expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).completedAt !== null).toBe(kind === 'task.reopened');
      completed.push(kind + ':duplicate-one-winner');
    } finally { pause.release(); await results; }
  });

  it(`${kind} activity failure rolls back inverse and claim; retry succeeds`, async () => {
    const f = await fixture(kind), before = await snapshot(f.project.id);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('COMPLETION_UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(editor, f.action.id)).rejects.toThrow('COMPLETION_UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks();
    expect(await snapshot(f.project.id)).toEqual(before);
    await undoAction(editor, f.action.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).completedAt !== null).toBe(kind === 'task.reopened');
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push(kind + ':activity-rollback-retry');
  });

  it(`${kind} Undo advances a future task version`, async () => {
    const f = await fixture(kind), stamp = new Date(Date.now() + 60_000);
    await db.task.update({ where: { id: f.task.id }, data: { updatedAt: stamp } });
    await undoAction(editor, f.action.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
    completed.push(kind + ':monotonic-version');
  });
}

it('Undo completion reopens only children still at the original cascade timestamp', async () => {
  const f = await fixture('task.completed');
  const original = await db.task.create({ data: { workspaceId, projectId: f.project.id, parentId: f.task.id, sectionId: f.done.id, title: 'Original cascade', assigneeId: leader.id, createdById: leader.id, completedAt: f.completedAt } });
  const later = await db.task.create({ data: { workspaceId, projectId: f.project.id, parentId: f.task.id, sectionId: f.done.id, title: 'Independently completed', assigneeId: leader.id, createdById: leader.id, completedAt: f.completedAt } });
  await db.actionLog.update({ where: { id: f.action.id }, data: { afterState: { completedAt: f.completedAt.toISOString(), subtaskIds: [original.id, later.id] } } });
  const laterStamp = new Date(f.completedAt.getTime() + 1000);
  await db.task.update({ where: { id: later.id }, data: { completedAt: laterStamp } });
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: original.id } })).completedAt).toBeNull();
  expect((await db.task.findUniqueOrThrow({ where: { id: later.id } })).completedAt).toEqual(laterStamp);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).completedAt).toBeNull();
  completed.push('completion-cohort-preserves-independent-later-child');
});
