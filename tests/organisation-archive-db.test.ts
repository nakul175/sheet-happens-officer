// Real PostgreSQL interleavings for ordinary CRM organisation archive changes.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { archiveOrganisation } from '@/lib/orgs';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'organisation-archive-' + randomUUID();
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
    mkdirSync('test-results/organisation-archive', { recursive: true });
    writeFileSync('test-results/organisation-archive/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'organisation-archive-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(archived = false) {
  const org = await db.organisation.create({ data: { workspaceId, name: prefix + '-org', createdById: author.id, archivedAt: archived ? new Date() : null } });
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

it('refuses a deactivated author after archive preflight without changing data or activity', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([archiveOrganisation(author, org.id, true)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin archiving another author’s organisation after preflight', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([archiveOrganisation(admin, org.id, true)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('former-admin-denied');
  } finally { pause.release(); await pending; }
});

it('does not log a second archive when state changes after preflight', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([archiveOrganisation(author, org.id, true)]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: org.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('archive-changed-after-preflight-denied');
  } finally { pause.release(); await pending; }
});

it('gives concurrent archive requests one winner and one action', async () => {
  const org = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([archiveOrganisation(author, org.id, true), archiveOrganisation(author, org.id, true)]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: 'organisation.archived' } })).toBe(1);
    completed.push('concurrent-archive-one-winner');
  } finally { pause.release(); await pending; }
});

it('allows a current author to archive and unarchive with one action each', async () => {
  const org = await fixture();
  await archiveOrganisation(author, org.id, true);
  await archiveOrganisation(author, org.id, false);
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).archivedAt).toBeNull();
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: { in: ['organisation.archived', 'organisation.unarchived'] } } })).toBe(2);
  completed.push('author-archive-unarchive-positive');
});

it('refuses an unarchive if the organisation changed after preflight', async () => {
  const org = await fixture(true), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([archiveOrganisation(author, org.id, false)]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: org.id }, data: { archivedAt: null } });
    const before = await snapshot(org.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('unarchive-changed-after-preflight-denied');
  } finally { pause.release(); await pending; }
});

it('allows a current Admin to archive another author’s organisation', async () => {
  const org = await fixture();
  await archiveOrganisation(admin, org.id, true);
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).archivedAt).not.toBeNull();
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: org.id, action: 'organisation.archived', actorId: admin.id } })).toBe(1);
  completed.push('admin-positive');
});

it('a competing organisation row lock returns a retryable conflict', async () => {
  const org = await fixture();
  let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${org.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(org.id);
    await expect(archiveOrganisation(author, org.id, true)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(org.id)).toEqual(before);
    completed.push('organisation-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await archiveOrganisation(author, org.id, true);
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).archivedAt).not.toBeNull();
});

it('rolls archive and activity back together, then allows a retry', async () => {
  const org = await fixture(), before = await snapshot(org.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('ORGANISATION_ARCHIVE_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(archiveOrganisation(author, org.id, true)).rejects.toThrow('ORGANISATION_ARCHIVE_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(org.id)).toEqual(before);
  await archiveOrganisation(author, org.id, true);
  expect((await db.organisation.findUniqueOrThrow({ where: { id: org.id } })).archivedAt).not.toBeNull();
  completed.push('activity-rollback-retry');
});
