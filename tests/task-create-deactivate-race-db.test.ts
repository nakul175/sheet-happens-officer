// Task creation versus account deactivation and access changes, on disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { archiveProject, changeMemberRole } from '@/lib/projects';
import { createTask } from '@/lib/tasks';
import { deactivate } from '@/lib/team';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-create-deactivate-' + randomUUID();
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
  if (safe) await db.user.updateMany({ where: { id: { in: [editor.id, recipient.id] } }, data: { deactivatedAt: null } });
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
    mkdirSync('test-results/task-create-deactivate-race', { recursive: true });
    writeFileSync('test-results/task-create-deactivate-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-create-deactivate-disposable-postgres', completed, cleanup }, null, 2));
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
  return { projectId: project.id, sectionId: section.id };
}
const input = (sectionId: string) => ({ title: 'New work', dueDate: '2026-11-20', sectionId, assigneeId: recipient.id });
function pauseBeforeTransactions() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('refuses an Editor downgraded after task-creation preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([createTask(editor, f.projectId, input(f.sectionId))]);
  try {
    await pause.ready(); await changeMemberRole(leader, f.projectId, editor.id, 'VIEWER'); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
    expect(await db.actionLog.count({ where: { projectId: f.projectId, action: 'task.created' } })).toBe(0);
    completed.push('downgraded-creator');
  } finally { pause.release(); await pending; }
});

it('refuses a project archived after task-creation preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([createTask(editor, f.projectId, input(f.sectionId))]);
  try {
    await pause.ready(); await archiveProject(leader, f.projectId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('refuses a creator deactivated after task-creation preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([createTask(editor, f.projectId, input(f.sectionId))]);
  try {
    await pause.ready(); await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
    completed.push('deactivated-creator');
  } finally { pause.release(); await pending; }
});

it('deactivation cannot miss a new task after the assignee eligibility check', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atCreate = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const original = tx.task.create.bind(tx.task);
    vi.spyOn(tx.task, 'create').mockImplementationOnce(((args) => {
      reached(); return held.then(() => original(args)) as ReturnType<typeof tx.task.create>;
    }) as typeof tx.task.create);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const creating = Promise.allSettled([createTask(leader, f.projectId, input(f.sectionId))]);
  const safety = setTimeout(() => release(), 10_000);
  try {
    await Promise.race([atCreate, creating.then(() => { throw Error('Creation passed its expected gate.'); })]);
    spy.mockRestore();
    await expect(deactivate(admin, recipient.id, 'leaders')).rejects.toMatchObject({ status: 409 });
  } finally { clearTimeout(safety); release(); spy.mockRestore(); await creating; }
  const [created] = await creating;
  expect(created.status).toBe('fulfilled');
  await deactivate(admin, recipient.id, 'leaders');
  const row = await db.task.findUniqueOrThrow({ where: { id: created.status === 'fulfilled' ? created.value : '' } });
  expect(row.assigneeId).toBe(leader.id);
  expect((await db.user.findUniqueOrThrow({ where: { id: recipient.id } })).deactivatedAt).not.toBeNull();
  completed.push('deactivation-handover-serialization');
}, 20_000);

it('current Editor can create an assigned task once with one action', async () => {
  const f = await fixture();
  const id = await createTask(editor, f.projectId, input(f.sectionId));
  expect((await db.task.findUniqueOrThrow({ where: { id } })).assigneeId).toBe(recipient.id);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: id, action: 'task.created' } })).toBe(1);
  completed.push('eligible-control');
});

it('refuses a locked recipient account and succeeds after a safe retry', async () => {
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
    await expect(createTask(leader, f.projectId, input(f.sectionId))).rejects.toMatchObject({ status: 409 });
    expect(await db.task.count({ where: { projectId: f.projectId } })).toBe(0);
  } finally { release(); await blocker; }
  const id = await createTask(leader, f.projectId, input(f.sectionId));
  expect((await db.task.findUniqueOrThrow({ where: { id } })).assigneeId).toBe(recipient.id);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: id, action: 'task.created' } })).toBe(1);
  completed.push('locked-recipient-retry');
});
