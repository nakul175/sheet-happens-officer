// Real PostgreSQL interleavings for deal.converted Undo in a disposable database.
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

const prefix = 'undo-conversion-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string, pipelineId: string, firstStageId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: 'DEAL_PROACTIVE' }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } });
  if (!pipeline?.stages[0]) throw Error('Disposable deal pipeline seed is incomplete.');
  pipelineId = pipeline.id; firstStageId = pipeline.stages[0].id;
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
    mkdirSync('test-results/undo-deal-conversion', { recursive: true });
    writeFileSync('test-results/undo-deal-conversion/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'deal-conversion-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function member(projectId: string) {
  await db.projectMember.createMany({ data: [
    { projectId, userId: leader.id, role: 'LEADER' },
    { projectId, userId: editor.id, role: 'EDITOR' },
  ] });
}
async function fixture() {
  const source = await db.project.create({ data: { workspaceId, name: prefix + '-source' } }); projects.push(source.id); await member(source.id);
  const sourceSection = await db.section.create({ data: { projectId: source.id, name: 'Doing', position: 0 } });
  const deal = await db.project.create({ data: { workspaceId, name: prefix + '-deal', typeId: 'wst_deal', pipelineId, stageId: firstStageId } }); projects.push(deal.id); await member(deal.id);
  const dealSection = await db.section.create({ data: { projectId: deal.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: deal.id, sectionId: dealSection.id, title: 'Converted task', assigneeId: leader.id, createdById: editor.id, isIdea: false } });
  const child = await db.task.create({ data: { workspaceId, projectId: deal.id, sectionId: dealSection.id, parentId: task.id, title: 'Original child', assigneeId: leader.id, createdById: editor.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: deal.id, targetType: 'deal', targetId: task.id, channel: 'SCREEN', action: 'deal.converted', beforeState: { sourceProjectId: source.id, sectionId: sourceSection.id, previousSectionId: null, isIdea: true, approverId: null, dueDate: null, subtaskIds: [child.id] }, afterState: { dealId: deal.id }, createdAt: new Date(Date.now() - 2000) } });
  return { source, sourceSection, deal, dealSection, task, child, action };
}
async function snapshot(ids: string[]) {
  const [projectRows, tasks, actions, notices] = await Promise.all([
    db.project.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }),
    db.task.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId: { in: ids } }, orderBy: { id: 'asc' } }),
  ]);
  return { projectRows, tasks, actions, notices };
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

it('refuses a removed deal member after preflight without moving the task family or claiming the action', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1), ids = [f.source.id, f.deal.id];
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await removeMember(leader, f.deal.id, editor.id);
    const before = await snapshot(ids); pause.release();
    const [result] = await pending, after = await snapshot(ids);
    const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    mkdirSync('test-results/undo-deal-conversion', { recursive: true });
    writeFileSync('test-results/undo-deal-conversion/verification.json', JSON.stringify({ dealActorRemoved: true, denied, unchanged, taskMoved: after.tasks.find((t) => t.id === f.task.id)?.projectId === f.source.id, actionClaimed: after.actions.find((row) => row.id === f.action.id)?.undoneAt !== null }, null, 2));
    expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
    completed.push('deal-member-removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('requires current access to the source project before moving the family back', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await removeMember(leader, f.source.id, editor.id);
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 404 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('source-access-required');
});

it('rejects Undo when a new child was added in the deal after conversion', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.task.create({ data: { workspaceId, projectId: f.deal.id, sectionId: f.dealSection.id, parentId: f.task.id, title: 'Later child', assigneeId: leader.id, createdById: editor.id } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('new-child-rejected');
});

it('rejects Undo when an original child has since moved to another project', async () => {
  const f = await fixture(), other = await db.project.create({ data: { workspaceId, name: prefix + '-other' } }); projects.push(other.id);
  const otherSection = await db.section.create({ data: { projectId: other.id, name: 'To do', position: 0 } });
  await db.task.update({ where: { id: f.child.id }, data: { projectId: other.id, sectionId: otherSection.id } });
  const ids = [f.source.id, f.deal.id, other.id], before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('moved-child-rejected');
});

it('rejects Undo after the original source project is archived during preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1), ids = [f.source.id, f.deal.id];
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await db.project.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(ids); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(ids)).toEqual(before);
    completed.push('source-archive-after-preflight');
  } finally { pause.release(); await pending; }
});

it('two simultaneous conversion Undo requests apply once and archive the deal once', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).projectId).toBe(f.source.id);
    expect(await db.actionLog.count({ where: { projectId: f.deal.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('activity failure rolls back family move, deal archive and claim; retry succeeds', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id], before = await snapshot(ids);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('CONVERSION_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.action.id)).rejects.toThrow('CONVERSION_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(ids)).toEqual(before);
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).projectId).toBe(f.source.id);
  expect((await db.project.findUniqueOrThrow({ where: { id: f.deal.id } })).archivedAt).not.toBeNull();
  completed.push('activity-rollback-retry');
});
