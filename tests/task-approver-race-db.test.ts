// Controlled approver writes versus account, project and task-version changes on disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { setApprover } from '@/lib/tasks';
import { deactivate } from '@/lib/team';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-approver-race-' + randomUUID();
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
  if (safe) await Promise.all([
    db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN', deactivatedAt: null } }),
    db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null } }),
  ]);
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
    mkdirSync('test-results/task-approver-race', { recursive: true });
    writeFileSync('test-results/task-approver-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-approver-disposable-postgres', completed, cleanup }, null, 2));
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
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: prefix, assigneeId: editor.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id, version: task.updatedAt.toISOString() };
}
function pauseBeforeTransactions() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects an Admin whose role was removed after approver preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([setApprover(admin, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBeNull();
    completed.push('lost-admin-role');
  } finally { pause.release(); await pending; }
});

it('rejects a project archived after approver preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([setApprover(leader, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await db.project.update({ where: { id: f.projectId }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBeNull();
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('rejects an actor deactivated after approver preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([setApprover(admin, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBeNull();
    completed.push('deactivated-actor');
  } finally { pause.release(); await pending; }
});

it('rejects an outdated task version after approver preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([setApprover(leader, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await db.task.update({ where: { id: f.taskId }, data: { priority: 'HIGH', updatedAt: new Date(new Date(f.version).getTime() + 1) } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect({ approver: row.approverId, priority: row.priority }).toEqual({ approver: null, priority: 'HIGH' });
    completed.push('changed-version');
  } finally { pause.release(); await pending; }
});

it('deactivation cannot miss a newly selected approver', async () => {
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
  const setting = Promise.allSettled([setApprover(leader, f.taskId, recipient.id, f.version)]);
  const safety = setTimeout(() => release(), 10_000);
  try {
    await Promise.race([atUpdate, setting.then(() => { throw Error('Approver update passed its expected gate.'); })]);
    spy.mockRestore();
    await expect(deactivate(admin, recipient.id, 'leaders')).rejects.toMatchObject({ status: 409 });
  } finally { clearTimeout(safety); release(); spy.mockRestore(); await setting; }
  expect((await setting)[0].status).toBe('fulfilled');
  await deactivate(admin, recipient.id, 'leaders');
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBe(leader.id);
  completed.push('deactivation-approver-serialization');
}, 20_000);

it('sets an eligible approver once with a matching action', async () => {
  const f = await fixture();
  await setApprover(leader, f.taskId, recipient.id, f.version);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBe(recipient.id);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.approver_changed' } })).toBe(1);
  completed.push('eligible-control');
});

it('two valid approver changes from the same version leave one winner and one conflict', async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([
    setApprover(leader, f.taskId, recipient.id, f.version),
    setApprover(leader, f.taskId, leader.id, f.version),
  ]);
  const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const losers = attempts.filter((attempt) => attempt.status === 'rejected');
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]).toMatchObject({ reason: { status: 409 } });
  const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect([recipient.id, leader.id]).toContain(row.approverId);
  const actions = await db.actionLog.findMany({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.approver_changed' } });
  expect(actions).toHaveLength(1);
  expect((actions[0].afterState as { approverId?: string }).approverId).toBe(row.approverId);
  completed.push('same-version-two-writers');
});

it('replaces an awaiting approver and holder together', async () => {
  const f = await fixture();
  await db.task.update({ where: { id: f.taskId }, data: { approverId: recipient.id, assigneeId: recipient.id } });
  const version = (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).updatedAt.toISOString();
  await setApprover(leader, f.taskId, editor.id, version);
  const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect({ approver: row.approverId, holder: row.assigneeId }).toEqual({ approver: editor.id, holder: editor.id });
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.approver_changed' } })).toBe(1);
  completed.push('awaiting-holder-control');
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
    await expect(setApprover(leader, f.taskId, recipient.id, f.version)).rejects.toMatchObject({ status: 409 });
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBeNull();
  } finally { release(); await blocker; }
  await setApprover(leader, f.taskId, recipient.id, f.version);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).approverId).toBe(recipient.id);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.approver_changed' } })).toBe(1);
  completed.push('locked-approver-retry');
});
