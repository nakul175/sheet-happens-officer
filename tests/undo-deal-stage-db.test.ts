// Real PostgreSQL interleavings for deal.stage_changed Undo in a disposable database.
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

const prefix = 'undo-deal-stage-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
let pipelineId: string, beforeId: string, afterId: string, laterId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: 'DEAL_PROACTIVE' }, include: { stages: { where: { isRetired: false }, orderBy: { position: 'asc' } } } });
  if (!pipeline || pipeline.stages.length < 3) throw Error('Disposable deal pipeline seed is incomplete.');
  pipelineId = pipeline.id;
  [beforeId, afterId, laterId] = pipeline.stages.slice(0, 3).map((stage) => stage.id);
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
    mkdirSync('test-results/undo-deal-stage', { recursive: true });
    writeFileSync('test-results/undo-deal-stage/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'deal-stage-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix, typeId: 'wst_deal', pipelineId, stageId: afterId, stageReason: 'after', stageChangedAt: new Date() } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'deal', targetId: project.id, channel: 'SCREEN', action: 'deal.stage_changed', beforeState: { stageId: beforeId, stage: 'Before', reason: 'before' }, afterState: { stageId: afterId, stage: 'After', reason: 'after' }, createdAt: new Date(Date.now() - 2000) } });
  return { project, action };
}
async function snapshot(projectId: string) {
  const [project, actions, notices] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { project, actions, notices };
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

it('refuses a removed Editor after preflight without changing stage or claiming the action', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await removeMember(leader, f.project.id, editor.id);
    const before = await snapshot(f.project.id); pause.release();
    const [result] = await pending, after = await snapshot(f.project.id);
    const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    mkdirSync('test-results/undo-deal-stage', { recursive: true });
    writeFileSync('test-results/undo-deal-stage/verification.json', JSON.stringify({ actorRemoved: true, denied, unchanged, stageReverted: after.project.stageId === beforeId, actionClaimed: after.actions.find((row) => row.id === f.action.id)?.undoneAt !== null }, null, 2));
    expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
    completed.push('removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('a later stage move after preflight needs conflict confirmation; override restores only stage fields', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.project.update({ where: { id: f.project.id }, data: { stageId: laterId, stageReason: 'later', description: 'keep' } });
    await db.actionLog.create({ data: { actorId: leader.id, projectId: f.project.id, targetType: 'deal', targetId: f.project.id, channel: 'SCREEN', action: 'deal.stage_changed', beforeState: { stageId: afterId }, afterState: { stageId: laterId } } });
    const before = await snapshot(f.project.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, extra: expect.objectContaining({ needsConfirm: 'conflict' }) }) })]);
    expect(await snapshot(f.project.id)).toEqual(before);
    await undoAction(editor, f.action.id, true);
    const project = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
    expect({ stageId: project.stageId, stageReason: project.stageReason, description: project.description }).toEqual({ stageId: beforeId, stageReason: 'before', description: 'keep' });
    expect(await db.notification.count({ where: { projectId: f.project.id, recipientId: leader.id, type: 'CHANGE_OVERRIDDEN' } })).toBe(1);
    completed.push('later-stage-conflict-override');
  } finally { pause.release(); await pending; }
});

it('rechecks Viewer downgrade after preflight before changing stage', async () => {
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

it('two simultaneous stage Undo requests claim and apply once', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).stageId).toBe(beforeId);
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('activity failure rolls back stage inverse and claim; retry succeeds', async () => {
  const f = await fixture(), before = await snapshot(f.project.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('STAGE_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.action.id)).rejects.toThrow('STAGE_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(f.project.id)).toEqual(before);
  await undoAction(editor, f.action.id);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).stageId).toBe(beforeId);
  completed.push('activity-rollback-retry');
});

it('stage Undo preserves a future project version', async () => {
  const f = await fixture(), stamp = new Date(Date.now() + 60_000);
  await db.project.update({ where: { id: f.project.id }, data: { updatedAt: stamp, description: 'keep' } });
  await undoAction(editor, f.action.id);
  const project = await db.project.findUniqueOrThrow({ where: { id: f.project.id } });
  expect(project.stageId).toBe(beforeId);
  expect(project.description).toBe('keep');
  expect(project.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  completed.push('monotonic-version');
});

it('rechecks archive after preflight before reverting the deal stage', async () => {
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

it('a competing project-row lock returns a retryable conflict without a claim', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.project.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('project-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).stageId).toBe(beforeId);
});

it('a competing historical-stage lock returns a retryable conflict without a claim', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Stage" WHERE "id" = ${beforeId} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id)).toEqual(before);
    completed.push('historical-stage-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).stageId).toBe(beforeId);
});

it('rejects a stage action whose target is not its authorized deal', async () => {
  const first = await fixture(), second = await fixture();
  await db.actionLog.update({ where: { id: first.action.id }, data: { targetId: second.project.id } });
  const beforeFirst = await snapshot(first.project.id), beforeSecond = await snapshot(second.project.id);
  await expect(undoAction(editor, first.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(first.project.id)).toEqual(beforeFirst);
  expect(await snapshot(second.project.id)).toEqual(beforeSecond);
  completed.push('foreign-target-rejected');
});
