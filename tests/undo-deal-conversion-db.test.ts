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
const sourceWorker = { id: prefix + '-source-worker', orgRole: 'MEMBER' as const };
const dealOnly = { id: prefix + '-deal-only', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string, pipelineId: string, firstStageId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: 'DEAL_PROACTIVE' }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } });
  if (!pipeline?.stages[0]) throw Error('Disposable deal pipeline seed is incomplete.');
  pipelineId = pipeline.id; firstStageId = pipeline.stages[0].id;
  for (const actor of [leader, editor, sourceWorker, dealOnly]) {
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
async function member(projectId: string, deal = false) {
  await db.projectMember.createMany({ data: [
    { projectId, userId: leader.id, role: 'LEADER' },
    { projectId, userId: editor.id, role: 'EDITOR' },
    { projectId, userId: sourceWorker.id, role: 'EDITOR' },
    ...(deal ? [{ projectId, userId: dealOnly.id, role: 'EDITOR' as const }] : []),
  ] });
}
async function fixture() {
  const source = await db.project.create({ data: { workspaceId, name: prefix + '-source' } }); projects.push(source.id); await member(source.id);
  const sourceSection = await db.section.create({ data: { projectId: source.id, name: 'Doing', position: 0 } });
  const deal = await db.project.create({ data: { workspaceId, name: prefix + '-deal', typeId: 'wst_deal', pipelineId, stageId: firstStageId } }); projects.push(deal.id); await member(deal.id, true);
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

it('refuses a source-project member removed after preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1), ids = [f.source.id, f.deal.id];
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await removeMember(leader, f.source.id, editor.id);
    const before = await snapshot(ids); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(ids)).toEqual(before);
    completed.push('source-member-removed-after-preflight');
  } finally { pause.release(); await pending; }
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

it('rejects a conversion action whose recorded deal is not its authorized project', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.actionLog.update({ where: { id: f.action.id }, data: { afterState: { dealId: f.source.id } } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('deal-identity-rejected');
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

it('a competing task-family row lock returns a retryable conflict without moving anything', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.child.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot([f.source.id, f.deal.id]);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot([f.source.id, f.deal.id])).toEqual(before);
    completed.push('family-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.child.id } })).projectId).toBe(f.source.id);
});

it('a competing source-project row lock returns a retryable conflict without a claim', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.source.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot([f.source.id, f.deal.id]);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot([f.source.id, f.deal.id])).toEqual(before);
    completed.push('source-project-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).projectId).toBe(f.source.id);
});

it('refuses to return a root task assigned to a deal-only person', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.task.id }, data: { assigneeId: dealOnly.id } });
  const before = await snapshot(ids);
  const result = await Promise.allSettled([undoAction(editor, f.action.id)]);
  const after = await snapshot(ids);
  const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 409;
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  mkdirSync('test-results/undo-deal-conversion', { recursive: true });
  writeFileSync('test-results/undo-deal-conversion/eligibility-verification.json', JSON.stringify({ dealOnlyHasSourceSeat: !!(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: f.source.id, userId: dealOnly.id } } })), denied, unchanged, taskReturned: after.tasks.find((t) => t.id === f.task.id)?.projectId === f.source.id }, null, 2));
  expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
  completed.push('root-assignee-source-eligibility');
});

it('refuses to return a child assigned to a deal-only person', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.child.id }, data: { assigneeId: dealOnly.id } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('child-assignee-source-eligibility');
});

it('refuses to return a task with a deal-only approver', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.task.id }, data: { approverId: dealOnly.id } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('approver-source-eligibility');
});

it('refuses to return a task with a deal-only collaborator', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.taskCollaborator.create({ data: { taskId: f.task.id, userId: dealOnly.id } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('collaborator-source-eligibility');
});

it('refuses to return a task after its source assignee was removed during preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.task.id }, data: { assigneeId: sourceWorker.id } });
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await removeMember(leader, f.source.id, sourceWorker.id);
    const before = await snapshot(ids); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(ids)).toEqual(before);
    completed.push('assignee-removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('refuses to return a task after its source assignee was downgraded to Viewer', async () => {
  const f = await fixture(), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.task.id }, data: { assigneeId: sourceWorker.id } });
  await db.projectMember.update({ where: { projectId_userId: { projectId: f.source.id, userId: sourceWorker.id } }, data: { role: 'VIEWER' } });
  const before = await snapshot(ids);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(ids)).toEqual(before);
  completed.push('assignee-viewer-source');
});

it('refuses to return a task after its source assignee was deactivated during preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1), ids = [f.source.id, f.deal.id];
  await db.task.update({ where: { id: f.task.id }, data: { assigneeId: sourceWorker.id } });
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: sourceWorker.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(ids); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(ids)).toEqual(before);
    completed.push('assignee-deactivated-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('a competing assignee user-row lock returns a retryable conflict without a move', async () => {
  const f = await fixture(); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${leader.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot([f.source.id, f.deal.id]);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot([f.source.id, f.deal.id])).toEqual(before);
    completed.push('person-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).projectId).toBe(f.source.id);
});
