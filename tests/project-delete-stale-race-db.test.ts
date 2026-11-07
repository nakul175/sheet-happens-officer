// Project deletion must use current authority and membership at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { deleteProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-delete-stale-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const people = [leader, admin], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
    await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: null } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-delete-stale-race', { recursive: true });
    writeFileSync('test-results/project-delete-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-delete-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.create({ data: { projectId: project.id, userId: leader.id, role: 'LEADER' } });
  return project.id;
}
function pauseBeforeTransaction() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects an Admin whose organisation role was revoked after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([deleteProject(admin, id, prefix)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects a Leader deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([deleteProject(leader, id, prefix)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});

it('notifies a new member who joined after deletion preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([deleteProject(leader, id, prefix)]);
  try {
    await pause.ready(); await db.projectMember.create({ data: { projectId: id, userId: admin.id, role: 'EDITOR' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'fulfilled' })]);
    expect(await db.notification.count({ where: { projectId: id, recipientId: admin.id, type: 'PROJECT_DELETED' } })).toBe(1);
    completed.push('new-member-notified');
  } finally { pause.release(); await pending; }
});

it('deletes an eligible project once and preserves it in Trash', async () => {
  const id = await fixture();
  expect(await deleteProject(admin, id, prefix)).toEqual({ deleted: true });
  expect((await db.project.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.deleted' } })).toBe(1);
  completed.push('eligible-control');
});

it('rejects a duplicate deletion without a second action', async () => {
  const id = await fixture();
  await deleteProject(admin, id, prefix);
  await expect(deleteProject(admin, id, prefix)).rejects.toMatchObject({ status: 404 });
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.deleted' } })).toBe(1);
  completed.push('duplicate-delete');
});

it('returns a retryable conflict for a locked project, then deletes once', async () => {
  const id = await fixture();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = transact(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR UPDATE`;
    reached(); await held;
  });
  const safety = setTimeout(() => release(), 15_000);
  try {
    await atLock;
    await expect(deleteProject(admin, id, prefix)).rejects.toMatchObject({ status: 409 });
    expect((await db.project.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  } finally { clearTimeout(safety); release(); await blocker; }
  await deleteProject(admin, id, prefix);
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.deleted' } })).toBe(1);
  completed.push('locked-project-retry');
}, 20_000);
