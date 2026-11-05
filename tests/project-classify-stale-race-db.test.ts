// Vertical classification must recheck authority and linked projects at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { classifyProject, updateProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-classify-stale-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: admin.id, workspaceId, name: admin.id, email: admin.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: admin.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN', deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.updateMany({ where: { id: { in: projects } }, data: { verticalId: null } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.delete({ where: { id: admin.id } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-classify-stale-race', { recursive: true });
    writeFileSync('test-results/project-classify-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-classify-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(isVertical = true) {
  const project = await db.project.create({ data: { workspaceId, name: prefix, isVertical } }); projects.push(project.id);
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
  const pending = Promise.allSettled([classifyProject(admin, id, false)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).isVertical).toBe(true);
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects an Admin deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([classifyProject(admin, id, false)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).isVertical).toBe(true);
    completed.push('deactivated-admin');
  } finally { pause.release(); await pending; }
});

it('rejects a project archived after classification preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([classifyProject(admin, id, false)]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).isVertical).toBe(true);
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('rejects retiring a vertical linked after the preflight count', async () => {
  const id = await fixture();
  const delivery = await db.project.create({ data: { workspaceId, name: prefix + '-delivery' } }); projects.push(delivery.id);
  const pause = pauseBeforeTransaction(), pending = Promise.allSettled([classifyProject(admin, id, false)]);
  try {
    await pause.ready(); await updateProject(admin, delivery.id, { verticalId: id }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.project.findUniqueOrThrow({ where: { id } })).isVertical).toBe(true);
    expect((await db.project.findUniqueOrThrow({ where: { id: delivery.id } })).verticalId).toBe(id);
    completed.push('late-delivery-link');
  } finally { pause.release(); await pending; }
});

it('classifies an eligible project and records the prior state', async () => {
  const id = await fixture(false);
  await classifyProject(admin, id, true);
  expect((await db.project.findUniqueOrThrow({ where: { id } })).isVertical).toBe(true);
  const action = await db.actionLog.findFirstOrThrow({ where: { projectId: id, action: 'project.classified' } });
  expect(action.beforeState).toMatchObject({ isVertical: false });
  completed.push('eligible-control');
});
