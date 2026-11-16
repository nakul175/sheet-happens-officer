// Controlled interleavings against disposable PostgreSQL; no mocked DB writes.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { updateTask } from '@/lib/tasks';
import { changeMemberRole, removeMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'edit-race-' + randomUUID();
const projects: string[] = [], users: string[] = [];
let workspaceId: string, safe = false;
const transact = db.$transaction.bind(db);
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
let sentinel: { id: string; title: string; updatedAt: Date };
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
    users.push(actor.id);
  }
  const f = await fixture();
  sentinel = await db.task.findUniqueOrThrow({ where: { id: f.taskId }, select: { id: true, title: true, updatedAt: true } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    if (sentinel) expect(await db.task.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, title: true, updatedAt: true } })).toEqual(sentinel);
  } finally {
    try {
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync('test-results/access-race', { recursive: true });
      writeFileSync('test-results/access-race/cleanup.json', JSON.stringify({ fixture: prefix, cleanup, scope: 'disposable-local-sho_test', projectCount: projects.length, userCount: users.length }, null, 2));
    }
  }
});

async function fixture(assignedToEditor = false) {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [{ projectId: project.id, userId: leader.id, role: 'LEADER' }, { projectId: project.id, userId: editor.id, role: 'EDITOR' }] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Original', assigneeId: assignedToEditor ? editor.id : leader.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id, version: task.updatedAt.toISOString() };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Pause AFTER each service preflight but BEFORE its real transaction. Restore
// the spy before calling membership services, so those transactions run normally.
function pauseBeforeTransactions(count: number) {
  const gate = latch(); let arrived = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++;
    await gate.promise;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); }, release: gate.release };
}

for (const mode of ['remove', 'downgrade'] as const) {
  it(`${mode} committed after preflight denies an in-flight ordinary edit without partial writes`, async () => {
    const f = await fixture(true), pause = pauseBeforeTransactions(1);
    const result = Promise.allSettled([updateTask(editor, f.taskId, { title: 'Unauthorized', expectedUpdatedAt: f.version })]);
    try {
      await pause.ready();
      if (mode === 'remove') await removeMember(leader, f.projectId, editor.id, leader.id);
      else await changeMemberRole(leader, f.projectId, editor.id, 'VIEWER', leader.id);
      const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
      const notices = await db.notification.count({ where: { taskId: f.taskId } });
      pause.release();
      expect(await result).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: mode === 'remove' ? 404 : 403 }) })]);
      expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
      expect(await db.actionLog.count({ where: { targetId: f.taskId, action: 'task.updated' } })).toBe(0);
      expect(await db.notification.count({ where: { taskId: f.taskId } })).toBe(notices);
    } finally { pause.release(); await result; }
  });
}

it('two edits of the same version serialize with exactly one commit and one conflict', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions(2);
  const results = Promise.allSettled(['First', 'Second'].map((title) => updateTask(editor, f.taskId, { title, expectedUpdatedAt: f.version })));
  try {
    await pause.ready(); pause.release();
    const settled = await results;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409, code: 'version_conflict' }) })]);
    const winner = settled.findIndex((r) => r.status === 'fulfilled');
    const row = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(row.title).toBe(['First', 'Second'][winner]); expect(row.updatedAt.getTime()).toBeGreaterThan(Date.parse(f.version));
    const logs = await db.actionLog.findMany({ where: { targetId: f.taskId, action: 'task.updated' } });
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ beforeState: { title: 'Original' }, afterState: { title: row.title } });
  } finally { pause.release(); await results; }
});

it('an edit that owns the membership lock commits before a competing removal', async () => {
  const f = await fixture(), gate = latch(); let pid = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const value = await callback(tx);
    pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    await gate.promise; return value;
  }, { timeout: 15_000, isolationLevel: 'ReadCommitted' })) as typeof db.$transaction);
  const edit = Promise.allSettled([updateTask(editor, f.taskId, { title: 'Committed before removal', expectedUpdatedAt: f.version })]);
  let removal: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await vi.waitFor(() => expect(pid).toBeGreaterThan(0), { timeout: 5000 }); spy.mockRestore();
    removal = Promise.allSettled([removeMember(leader, f.projectId, editor.id)]);
    // Observe the actual PostgreSQL waiter, not an arbitrary sleep/promise timing.
    await vi.waitFor(async () => {
      const blocked = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%ProjectMember%'`;
      expect(Number(blocked[0].count)).toBeGreaterThan(0);
    }, { timeout: 5000 });
    gate.release();
    expect((await edit)[0].status).toBe('fulfilled'); expect((await removal)[0].status).toBe('fulfilled');
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).title).toBe('Committed before removal');
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: f.projectId, userId: editor.id } } })).toBeNull();
    expect(await db.actionLog.count({ where: { targetId: f.taskId, action: 'task.updated' } })).toBe(1);
  } finally { gate.release(); await edit; await removal; }
});

it('a role-change membership lock cannot deadlock an ordinary edit', async () => {
  const f = await fixture(), gate = latch(); let locked = false;
  const change = Promise.allSettled([transact(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId"=${f.projectId} AND "userId"=${editor.id} FOR UPDATE`;
    locked = true; await gate.promise;
  }, { timeout: 15_000 })]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    // The edit must finish without requiring the membership owner to release.
    await expect(updateTask(editor, f.taskId, { title: 'Blocked by role change', expectedUpdatedAt: f.version })).rejects.toMatchObject({ status: 409 });
    expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).title).toBe('Original');
    expect(await db.actionLog.count({ where: { targetId: f.taskId, action: 'task.updated' } })).toBe(0);
  } finally { gate.release(); expect((await change)[0].status).toBe('fulfilled'); }
});
