// Real PostgreSQL interleavings for task.moved Undo in a disposable database.
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

const prefix = 'undo-move-' + randomUUID();
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
    mkdirSync('test-results/undo-move', { recursive: true });
    writeFileSync('test-results/undo-move/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-move-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const from = await db.section.create({ data: { projectId: project.id, name: 'From', position: 0 } });
  const to = await db.section.create({ data: { projectId: project.id, name: 'To', position: 1 } });
  const later = await db.section.create({ data: { projectId: project.id, name: 'Later', position: 2 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: to.id, title: 'Moved task', assigneeId: leader.id, createdById: leader.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: 'task.moved', beforeState: { sectionId: from.id }, afterState: { sectionId: to.id }, createdAt: new Date(Date.now() - 2000) } });
  return { project, from, to, later, task, action };
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

it('refuses a removed actor after Undo preflight without moving the task or claiming the action', async () => {
  const { project, from, action } = await fixture();
  let reached!: () => void, release!: () => void;
  const atTransaction = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    reached(); await held; return transact(callback, options);
  }) as typeof db.$transaction);
  const pending = undoAction(editor, action.id);
  let before: Awaited<ReturnType<typeof snapshot>>;
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atTransaction, pending.then(() => { throw Error('Undo passed the expected transaction gate.'); })]);
    intercepted.mockRestore();
    await removeMember(leader, project.id, editor.id);
    before = await snapshot(project.id);
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
  }
  const result = await Promise.allSettled([pending]);
  const after = await snapshot(project.id);
  const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
  const unchanged = JSON.stringify(after) === JSON.stringify(before!);
  mkdirSync('test-results/undo-move', { recursive: true });
  writeFileSync('test-results/undo-move/verification.json', JSON.stringify({ actorRemoved: true, denied, unchanged, sectionReverted: after.tasks[0].sectionId === from.id, actionClaimed: (after.actions.find((row) => row.id === action.id)?.undoneAt ?? null) !== null, safetyExpired }, null, 2));
  expect({ denied, unchanged, safetyExpired }).toEqual({ denied: true, unchanged: true, safetyExpired: false });
  completed.push('removed-after-preflight');
}, 20_000);

it('a later move requires confirmation; explicit override preserves other fields and records a notice', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const result = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.task.update({ where: { id: f.task.id }, data: { sectionId: f.later.id, priority: 'HIGH' } });
    await db.actionLog.create({ data: { actorId: leader.id, projectId: f.project.id, targetType: 'task', targetId: f.task.id, channel: 'SCREEN', action: 'task.moved', beforeState: { sectionId: f.to.id }, afterState: { sectionId: f.later.id } } });
    const before = await snapshot(f.project.id); pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'conflict' }) }) })]);
    expect(await snapshot(f.project.id)).toEqual(before);
    expect(await undoAction(editor, f.action.id, true)).toMatchObject({ overrode: true });
    const task = await db.task.findUniqueOrThrow({ where: { id: f.task.id } });
    expect(task.sectionId).toBe(f.from.id);
    expect(task.priority).toBe('HIGH');
    expect(task.updatedAt.getTime()).toBeGreaterThan(before.tasks[0].updatedAt.getTime());
    expect(await db.notification.count({ where: { projectId: f.project.id, recipientId: leader.id, type: 'CHANGE_OVERRIDDEN' } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: f.task.id, event: 'UNDO_OVERRIDE' } })).toBe(1);
    completed.push('later-move-conflict-and-override');
  } finally { pause.release(); await result; }
});

it('two simultaneous Undo requests apply exactly one inverse and activity row', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const results = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); pause.release(); const settled = await results;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).sectionId).toBe(f.from.id);
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneById).toBe(editor.id);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await results; }
});

it('activity failure rolls back the inverse and claim, then retry succeeds', async () => {
  const f = await fixture(), before = await snapshot(f.project.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('MOVE_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.action.id)).rejects.toThrow('MOVE_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(f.project.id)).toEqual(before);
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).sectionId).toBe(f.from.id);
  expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
  completed.push('activity-rollback-and-retry');
});

it('a competing membership lock returns a retryable conflict without changing the move', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${f.project.id} AND "userId" = ${editor.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('membership-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
});

it('Undo advances a future task version while reverting only its section', async () => {
  const f = await fixture(), stamp = new Date(Date.now() + 60_000);
  await db.task.update({ where: { id: f.task.id }, data: { updatedAt: stamp, priority: 'HIGH' } });
  await undoAction(editor, f.action.id);
  const task = await db.task.findUniqueOrThrow({ where: { id: f.task.id } });
  expect(task.sectionId).toBe(f.from.id);
  expect(task.priority).toBe('HIGH');
  expect(task.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  completed.push('monotonic-version');
});
