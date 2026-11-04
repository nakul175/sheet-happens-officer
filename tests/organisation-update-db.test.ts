// Real PostgreSQL interleavings for ordinary CRM organisation updates.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { updateOrganisation } from '@/lib/orgs';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'organisation-update-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const users = [author.id, admin.id], organisations: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [author, admin]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: author.id }, data: { deactivatedAt: null } });
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.actionLog.deleteMany({ where: { targetType: 'organisation', targetId: { in: organisations } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/organisation-update', { recursive: true });
    writeFileSync('test-results/organisation-update/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'organisation-update-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(name = prefix + '-original') {
  const org = await db.organisation.create({ data: { workspaceId, name, createdById: author.id } });
  organisations.push(org.id);
  return org;
}
async function snapshot(id: string) {
  return { organisation: await db.organisation.findUniqueOrThrow({ where: { id } }), actions: await db.actionLog.findMany({ where: { targetType: 'organisation', targetId: id }, orderBy: { id: 'asc' } }) };
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

it('refuses a deactivated author after update preflight without changing data or activity', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(author, org.id, { name: prefix + '-edited' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin editing another author’s organisation after preflight', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(admin, org.id, { name: prefix + '-edited' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('former-admin-denied');
  } finally { pause.release(); await pending; }
});

it('does not write an organisation archived after update preflight', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(author, org.id, { name: prefix + '-edited' })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: org.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('archive-after-preflight-denied');
  } finally { pause.release(); await pending; }
});

it('does not form a parent cycle when ancestry changes after update preflight', async () => {
  const child = await fixture(), parent = await fixture(prefix + '-parent');
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(author, child.id, { parentId: parent.id })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: parent.id }, data: { parentId: child.id } });
    const before = await snapshot(child.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(child.id)).toEqual(before);
    completed.push('parent-cycle-after-preflight-denied');
  } finally {
    pause.release(); await pending;
    await db.organisation.update({ where: { id: parent.id }, data: { parentId: null } });
    await db.organisation.update({ where: { id: child.id }, data: { parentId: null } });
  }
});

it('allows a current author to edit an active organisation with one action', async () => {
  const org = await fixture();
  await updateOrganisation(author, org.id, { name: prefix + '-edited' });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).name).toBe(prefix + '-edited');
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: 'organisation.updated' } })).toBe(1);
  completed.push('author-positive');
});
