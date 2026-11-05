// Controlled send-for-approval writes against membership, project and deactivation changes.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { sendForApproval } from '@/lib/tasks';
import { deactivate } from '@/lib/team';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-send-approval-race-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const people = [admin, leader, editor, recipient];
const projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!safe) return;
  await db.user.updateMany({ where: { id: { in: [editor.id, recipient.id] } }, data: { deactivatedAt: null } });
  await db.projectMember.updateMany({ where: { projectId: { in: projects }, userId: editor.id }, data: { role: 'EDITOR' } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/task-send-approval-race', { recursive: true });
    writeFileSync('test-results/task-send-approval-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-send-approval-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
    { projectId: project.id, userId: recipient.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: prefix, assigneeId: editor.id, approverId: recipient.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id };
}
function pauseBeforeTransactions() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('refuses an assignee downgraded after send preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  try {
    await pause.ready(); await db.projectMember.update({ where: { projectId_userId: { projectId: f.projectId, userId: editor.id } }, data: { role: 'VIEWER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(editor.id);
    completed.push('downgraded-assignee');
  } finally { pause.release(); await pending; }
});

it('refuses an archived project after send preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  try {
    await pause.ready(); await db.project.update({ where: { id: f.projectId }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(editor.id);
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('refuses an actor deactivated after send preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(editor.id);
    completed.push('deactivated-actor');
  } finally { pause.release(); await pending; }
});

it('refuses a task reassigned after send preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  try {
    await pause.ready(); await db.task.update({ where: { id: f.taskId }, data: { assigneeId: leader.id } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(leader.id);
    completed.push('changed-assignee');
  } finally { pause.release(); await pending; }
});

it('refuses an approver changed after send preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  try {
    await pause.ready(); await db.task.update({ where: { id: f.taskId }, data: { approverId: leader.id } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect({ holder: row.assigneeId, approver: row.approverId }).toEqual({ holder: editor.id, approver: leader.id });
    completed.push('changed-approver');
  } finally { pause.release(); await pending; }
});

it('deactivation cannot miss an in-flight send to the approver', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atUpdate = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const original = tx.task.update.bind(tx.task);
    vi.spyOn(tx.task, 'update').mockImplementationOnce(((args) => {
      reached(); return held.then(() => original(args)) as ReturnType<typeof tx.task.update>;
    }) as typeof tx.task.update);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const sending = Promise.allSettled([sendForApproval(editor, f.taskId)]);
  const safety = setTimeout(() => release(), 10_000);
  try {
    await Promise.race([atUpdate, sending.then(() => { throw Error('Send passed its expected gate.'); })]);
    spy.mockRestore();
    await expect(deactivate(admin, recipient.id, 'leaders')).rejects.toMatchObject({ status: 409 });
  } finally { clearTimeout(safety); release(); spy.mockRestore(); await sending; }
  expect((await sending)[0].status).toBe('fulfilled');
  await deactivate(admin, recipient.id, 'leaders');
  const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect(row.assigneeId).toBe(leader.id);
  expect(row.approverId).toBe(leader.id);
  completed.push('deactivation-send-serialization');
}, 20_000);

it('sends an eligible task once with holder and action matching', async () => {
  const f = await fixture();
  await sendForApproval(editor, f.taskId);
  const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect({ holder: row.assigneeId, previous: row.previousAssigneeId, approver: row.approverId }).toEqual({ holder: recipient.id, previous: editor.id, approver: recipient.id });
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.sent_for_approval' } })).toBe(1);
  completed.push('eligible-control');
});

it('rejects a repeated send without a duplicate action', async () => {
  const f = await fixture();
  await sendForApproval(editor, f.taskId);
  await expect(sendForApproval(editor, f.taskId)).rejects.toMatchObject({ status: 409 });
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.sent_for_approval' } })).toBe(1);
  completed.push('repeated-send');
});

it('refuses a locked approver account then succeeds after retry', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${recipient.id} FOR UPDATE`;
    reached(); await held;
  });
  try {
    await atLock;
    await expect(sendForApproval(editor, f.taskId)).rejects.toMatchObject({ status: 409 });
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(editor.id);
  } finally { release(); await blocker; }
  await sendForApproval(editor, f.taskId);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).assigneeId).toBe(recipient.id);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.sent_for_approval' } })).toBe(1);
  completed.push('locked-approver-retry');
});
