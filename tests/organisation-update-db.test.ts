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

it('refuses to overwrite a newer organisation edit made after preflight', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(author, org.id, { name: prefix + '-stale' })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: org.id }, data: { name: prefix + '-newer' } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('newer-edit-after-preflight-denied');
  } finally { pause.release(); await pending; }
});

it('allows an active Admin to edit another author’s organisation', async () => {
  const org = await fixture();
  await updateOrganisation(admin, org.id, { kind: 'Partner' });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).kind).toBe('Partner');
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: 'organisation.updated', actorId: admin.id } })).toBe(1);
  completed.push('admin-positive');
});

it('restores a valid parent change and records its actual before and after facts', async () => {
  const child = await fixture(), parent = await fixture(prefix + '-parent');
  await updateOrganisation(author, child.id, { parentId: parent.id });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(parent.id);
  const action = await db.actionLog.findFirstOrThrow({ where: { targetType: 'organisation', targetId: child.id, action: 'organisation.updated' } });
  expect(action.beforeState).toMatchObject({ parentId: null });
  expect(action.afterState).toMatchObject({ parentId: parent.id });
  await db.organisation.update({ where: { id: child.id }, data: { parentId: null } });
  completed.push('valid-parent-and-log-positive');
});

it('rejects a parent archived after update preflight without changing the child', async () => {
  const child = await fixture(), parent = await fixture(prefix + '-parent');
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateOrganisation(author, child.id, { parentId: parent.id })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(child.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(child.id)).toEqual(before);
    completed.push('archived-parent-after-preflight-denied');
  } finally { pause.release(); await pending; }
});

it('returns a retryable conflict when a parent row is being changed', async () => {
  const child = await fixture(), parent = await fixture(prefix + '-parent');
  let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${parent.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(child.id);
    await expect(updateOrganisation(author, child.id, { parentId: parent.id })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(child.id)).toEqual(before);
    completed.push('parent-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await updateOrganisation(author, child.id, { parentId: parent.id });
  await db.organisation.update({ where: { id: child.id }, data: { parentId: null } });
});

it('rolls the organisation edit back if activity logging fails, then retries once', async () => {
  const org = await fixture(), before = await snapshot(org.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('ORGANISATION_UPDATE_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(updateOrganisation(author, org.id, { name: prefix + '-edited' })).rejects.toThrow('ORGANISATION_UPDATE_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(org.id)).toEqual(before);
  await updateOrganisation(author, org.id, { name: prefix + '-edited' });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).name).toBe(prefix + '-edited');
  completed.push('activity-rollback-retry');
});

it('gives two concurrent stale organisation edits one winner and one activity', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([
    updateOrganisation(author, org.id, { name: prefix + '-first' }),
    updateOrganisation(author, org.id, { name: prefix + '-second' }),
  ]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: 'organisation.updated' } })).toBe(1);
    completed.push('concurrent-edit-one-winner');
  } finally { pause.release(); await pending; }
});

it('a competing account lock yields a retryable conflict before updating', async () => {
  const org = await fixture();
  let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(org.id);
    await expect(updateOrganisation(author, org.id, { name: prefix + '-edited' })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('account-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await updateOrganisation(author, org.id, { name: prefix + '-edited' });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).name).toBe(prefix + '-edited');
});
