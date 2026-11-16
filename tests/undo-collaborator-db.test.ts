// Real PostgreSQL interleavings for collaborator add/remove Undo.
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

const prefix = 'undo-collaborator-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const colleague = { id: prefix + '-colleague', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor, colleague]) {
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
    mkdirSync('test-results/undo-collaborator', { recursive: true });
    writeFileSync('test-results/undo-collaborator/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'collaborator-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture(kind: 'task.collaborator_added' | 'task.collaborator_removed') {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + kind } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
    { projectId: project.id, userId: colleague.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: kind, assigneeId: leader.id, createdById: leader.id } });
  if (kind === 'task.collaborator_added') await db.taskCollaborator.create({ data: { taskId: task.id, userId: colleague.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind,
    beforeState: kind === 'task.collaborator_removed' ? { userId: colleague.id } : {},
    afterState: kind === 'task.collaborator_added' ? { userId: colleague.id } : {},
    createdAt: new Date(Date.now() - 2000) } });
  return { project, task, action };
}
async function snapshot(projectId: string, taskId: string) {
  const [collaborators, actions, notices] = await Promise.all([
    db.taskCollaborator.findMany({ where: { taskId }, orderBy: { userId: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { collaborators, actions, notices };
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

for (const kind of ['task.collaborator_added', 'task.collaborator_removed'] as const) {
  it(`${kind} Undo refuses an actor removed after preflight without changing collaborator/action/activity`, async () => {
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
      before = await snapshot(f.project.id, f.task.id);
    } finally {
      clearTimeout(safety); release(); intercepted.mockRestore();
    }
    const result = await Promise.allSettled([pending]);
    const after = await snapshot(f.project.id, f.task.id);
    const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before!);
    mkdirSync('test-results/undo-collaborator', { recursive: true });
    writeFileSync(`test-results/undo-collaborator/verification-${kind}.json`, JSON.stringify({ kind, actorRemoved: true, denied, unchanged, actionClaimed: (after.actions.find((x) => x.id === f.action.id)?.undoneAt ?? null) !== null, collaboratorPresent: after.collaborators.some((x) => x.userId === colleague.id), safetyExpired }, null, 2));
    expect({ denied, unchanged, safetyExpired }).toEqual({ denied: true, unchanged: true, safetyExpired: false });
    completed.push(kind + ':removed-after-preflight');
  }, 20_000);

  it(`${kind} Undo rechecks collaborator state after preflight`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const result = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      if (kind === 'task.collaborator_added') await db.taskCollaborator.delete({ where: { taskId_userId: { taskId: f.task.id, userId: colleague.id } } });
      else await db.taskCollaborator.create({ data: { taskId: f.task.id, userId: colleague.id } });
      const before = await snapshot(f.project.id, f.task.id); pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
      expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
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
      expect(await db.taskCollaborator.count({ where: { taskId: f.task.id, userId: colleague.id } })).toBe(kind === 'task.collaborator_removed' ? 1 : 0);
      completed.push(kind + ':duplicate-one-winner');
    } finally { pause.release(); await results; }
  });

  it(`${kind} activity failure rolls back inverse and claim; retry succeeds`, async () => {
    const f = await fixture(kind), before = await snapshot(f.project.id, f.task.id);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('COLLABORATOR_UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(editor, f.action.id)).rejects.toThrow('COLLABORATOR_UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks();
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    await undoAction(editor, f.action.id);
    expect(await db.taskCollaborator.count({ where: { taskId: f.task.id, userId: colleague.id } })).toBe(kind === 'task.collaborator_removed' ? 1 : 0);
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push(kind + ':activity-rollback-retry');
  });
}

it('restoring a collaborator refuses a recipient who has left the project', async () => {
  const f = await fixture('task.collaborator_removed');
  await removeMember(leader, f.project.id, colleague.id);
  const before = await snapshot(f.project.id, f.task.id);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
  completed.push('recipient-departed');
});

it('a recipient membership lock makes collaborator restoration retryable without a partial claim', async () => {
  const f = await fixture('task.collaborator_removed'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${f.project.id} AND "userId" = ${colleague.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('recipient-membership-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect(await db.taskCollaborator.count({ where: { taskId: f.task.id, userId: colleague.id } })).toBe(1);
});

it('a collaborator-row lock makes removal Undo retryable without a partial claim', async () => {
  const f = await fixture('task.collaborator_added'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "taskId" FROM "TaskCollaborator" WHERE "taskId" = ${f.task.id} AND "userId" = ${colleague.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('collaborator-row-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect(await db.taskCollaborator.count({ where: { taskId: f.task.id, userId: colleague.id } })).toBe(0);
});
