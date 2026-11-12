// Project edits must recheck actor, project version and vertical at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { updateProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-update-stale-' + randomUUID();
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
    await db.project.updateMany({ where: { id: { in: projects } }, data: { verticalId: null } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-update-stale-race', { recursive: true });
    writeFileSync('test-results/project-update-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-update-disposable-postgres', completed, cleanup }, null, 2));
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
  const pending = Promise.allSettled([updateProject(admin, id, { name: 'Wrong rename' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe(prefix);
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects a Leader deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateProject(leader, id, { name: 'Wrong rename' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe(prefix);
    completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});

it('rejects a project archived after edit preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateProject(leader, id, { name: 'Wrong rename' })]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe(prefix);
    completed.push('archived-after-preflight');
  } finally { pause.release(); await pending; }
});

it('rejects a competing rename instead of overwriting it', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateProject(leader, id, { name: 'Stale rename' })]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { name: 'Winning rename' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe('Winning rename');
    completed.push('competing-rename');
  } finally { pause.release(); await pending; }
});

it('rejects a vertical retired after validation but before linking', async () => {
  const id = await fixture();
  const vertical = await db.project.create({ data: { workspaceId, name: prefix + '-vertical', isVertical: true } }); projects.push(vertical.id);
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateProject(leader, id, { verticalId: vertical.id })]);
  try {
    await pause.ready(); await db.project.update({ where: { id: vertical.id }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).verticalId).toBeNull();
    completed.push('retired-vertical');
  } finally { pause.release(); await pending; }
});

it('updates an eligible project once with an accurate before image', async () => {
  const id = await fixture();
  await updateProject(admin, id, { name: 'Updated project' });
  expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe('Updated project');
  const action = await db.actionLog.findFirstOrThrow({ where: { projectId: id, action: 'project.updated' } });
  expect(action.beforeState).toMatchObject({ name: prefix });
  completed.push('eligible-control');
});

it('returns a retryable conflict for a locked project, then updates once', async () => {
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
    await expect(updateProject(admin, id, { name: 'Updated project' })).rejects.toMatchObject({ status: 409 });
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe(prefix);
  } finally { clearTimeout(safety); release(); await blocker; }
  await updateProject(admin, id, { name: 'Updated project' });
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.updated' } })).toBe(1);
  completed.push('locked-project-retry');
}, 20_000);

it('returns a retryable conflict for a changing vertical, then links it once', async () => {
  const id = await fixture();
  const vertical = await db.project.create({ data: { workspaceId, name: prefix + '-vertical-lock', isVertical: true } }); projects.push(vertical.id);
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = transact(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${vertical.id} FOR UPDATE`;
    reached(); await held;
  });
  const safety = setTimeout(() => release(), 15_000);
  try {
    await atLock;
    await expect(updateProject(leader, id, { verticalId: vertical.id })).rejects.toMatchObject({ status: 409 });
    expect((await db.project.findUniqueOrThrow({ where: { id } })).verticalId).toBeNull();
  } finally { clearTimeout(safety); release(); await blocker; }
  await updateProject(leader, id, { verticalId: vertical.id });
  expect((await db.project.findUniqueOrThrow({ where: { id } })).verticalId).toBe(vertical.id);
  completed.push('locked-vertical-retry');
}, 20_000);
