// Unarchive must recheck the current actor and project inside its write transaction.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { unarchiveProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-unarchive-stale-' + randomUUID();
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
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-unarchive-stale-race', { recursive: true });
    writeFileSync('test-results/project-unarchive-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-unarchive-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix, archivedAt: new Date() } }); projects.push(project.id);
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
  const pending = Promise.allSettled([unarchiveProject(admin, id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects a duplicate unarchive completed after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([unarchiveProject(leader, id)]);
  try {
    await pause.ready(); await unarchiveProject(leader, id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { projectId: id, action: 'project.unarchived' } })).toBe(1);
    completed.push('duplicate-unarchive');
  } finally { pause.release(); await pending; }
});

it('rejects a Leader deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([unarchiveProject(leader, id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});

it('rejects a newly classified vertical for a non-admin Leader', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([unarchiveProject(leader, id)]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { isVertical: true } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    completed.push('new-vertical');
  } finally { pause.release(); await pending; }
});

it('unarchives an eligible project once and logs the actual prior archive time', async () => {
  const id = await fixture();
  const before = await db.project.findUniqueOrThrow({ where: { id } });
  await unarchiveProject(admin, id);
  expect((await db.project.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
  const action = await db.actionLog.findFirstOrThrow({ where: { projectId: id, action: 'project.unarchived' } });
  expect(action.beforeState).toMatchObject({ archivedAt: before.archivedAt!.toISOString() });
  completed.push('eligible-control');
});
