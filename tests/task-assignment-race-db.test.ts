// Controlled ordinary assignment interleavings against disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { assignTask } from '@/lib/tasks';
import { archiveProject, changeMemberRole, removeMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'assignment-race-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let safe = false, workspaceId: string, sentinelId: string;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor, recipient]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
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
    await db.auditLog.deleteMany({ where: { actorId: { in: [leader.id, editor.id, recipient.id] } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id, recipient.id] } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/task-assignment-race', { recursive: true });
    writeFileSync('test-results/task-assignment-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'ordinary-assignment-disposable-postgres', completed, cleanup }, null, 2));
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
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Assignment', assigneeId: leader.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id, version: task.updatedAt.toISOString() };
}

async function snapshot(taskId: string) {
  return {
    task: await db.task.findUniqueOrThrow({ where: { id: taskId } }),
    actions: await db.actionLog.findMany({ where: { targetId: taskId, action: 'task.assigned' }, orderBy: { id: 'asc' } }),
    notices: await db.notification.findMany({ where: { taskId, type: { in: ['TASK_ASSIGNED', 'REMOVED_AS_ASSIGNEE'] } }, orderBy: { id: 'asc' } }),
  };
}

function pauseBeforeTransactions(count: number) {
  let release!: () => void, arrived = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects a removed actor after preflight without assignment or side effects', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([assignTask(editor, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await removeMember(leader, f.projectId, editor.id);
    const before = await snapshot(f.taskId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(f.taskId)).toEqual(before); completed.push('removed-actor');
  } finally { pause.release(); await pending; }
});

it('rejects a downgraded actor after preflight without assignment or side effects', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([assignTask(editor, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await changeMemberRole(leader, f.projectId, editor.id, 'VIEWER');
    const before = await snapshot(f.taskId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.taskId)).toEqual(before); completed.push('downgraded-actor');
  } finally { pause.release(); await pending; }
});

it('rejects an archived project after preflight without assignment or side effects', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([assignTask(editor, f.taskId, recipient.id, f.version)]);
  try {
    await pause.ready(); await archiveProject(leader, f.projectId);
    const before = await snapshot(f.taskId); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.taskId)).toEqual(before); completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('serializes two assignments of one version with one winner', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([
    assignTask(leader, f.taskId, recipient.id, f.version),
    assignTask(editor, f.taskId, editor.id, f.version),
  ]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409, code: 'version_conflict' }) })]);
    expect((await snapshot(f.taskId)).actions).toHaveLength(1); completed.push('one-version-one-winner');
  } finally { pause.release(); await pending; }
});

it('commits an eligible assignment with one action and recipient notice', async () => {
  const f = await fixture();
  const version = await assignTask(editor, f.taskId, recipient.id, f.version);
  const after = await snapshot(f.taskId);
  expect(after.task.assigneeId).toBe(recipient.id);
  expect(version.getTime()).toBe(after.task.updatedAt.getTime());
  expect(after.actions).toHaveLength(1);
  expect(after.notices.some((n) => n.type === 'TASK_ASSIGNED' && n.recipientId === recipient.id)).toBe(true);
  completed.push('eligible-control');
});
