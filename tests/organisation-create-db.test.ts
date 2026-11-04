// Real PostgreSQL interleavings for ordinary CRM organisation creation.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { createOrganisation } from '@/lib/orgs';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'organisation-create-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
let safe = false, workspaceId: string, sentinelId: string;
const completed: string[] = [];
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: author.id, workspaceId, name: author.id, email: author.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: author.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: author.id }, data: { deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    const ids = (await db.organisation.findMany({ where: { workspaceId, name: { startsWith: prefix } }, select: { id: true } })).map((x) => x.id);
    await db.actionLog.deleteMany({ where: { targetType: 'organisation', targetId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { actorId: author.id } });
    await db.organisation.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
    await db.organisation.deleteMany({ where: { id: { in: ids } } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.delete({ where: { id: author.id } });
    expect(await db.organisation.count({ where: { workspaceId, name: { startsWith: prefix } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/organisation-create', { recursive: true });
    writeFileSync('test-results/organisation-create/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'organisation-create-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function snapshot() {
  const organisations = await db.organisation.findMany({ where: { workspaceId, name: { startsWith: prefix } }, orderBy: { id: 'asc' } });
  const actions = await db.actionLog.findMany({ where: { targetType: 'organisation', targetId: { in: organisations.map((x) => x.id) } }, orderBy: { id: 'asc' } });
  return { organisations, actions };
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

it('refuses a deactivated author after create preflight without a row or action', async () => {
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createOrganisation(author, { name: prefix + '-new' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses to create beneath a parent archived after preflight', async () => {
  const parent = await db.organisation.create({ data: { workspaceId, name: prefix + '-parent', createdById: author.id } });
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createOrganisation(author, { name: prefix + '-child', parentId: parent.id })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('archived-parent-denied');
  } finally { pause.release(); await pending; }
});

it('gives concurrent same-name creates one winner and one action', async () => {
  const pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([
    createOrganisation(author, { name: prefix + '-duplicate' }),
    createOrganisation(author, { name: prefix + '-duplicate' }),
  ]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const rows = await db.organisation.findMany({ where: { workspaceId, name: prefix + '-duplicate' } });
    expect(rows).toHaveLength(1);
    expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: rows[0].id, action: 'organisation.created' } })).toBe(1);
    completed.push('concurrent-duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('allows a current author to create one organisation with one action', async () => {
  const row = await createOrganisation(author, { name: prefix + '-normal' });
  expect((await db.organisation.findUniqueOrThrow({ where: { id: row.id } })).name).toBe(prefix + '-normal');
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: row.id, action: 'organisation.created' } })).toBe(1);
  completed.push('author-positive');
});

it('creates beneath a current parent and logs its parent ID', async () => {
  const parent = await db.organisation.create({ data: { workspaceId, name: prefix + '-valid-parent', createdById: author.id } });
  const child = await createOrganisation(author, { name: prefix + '-valid-child', parentId: parent.id });
  expect(child.parentId).toBe(parent.id);
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: child.id, action: 'organisation.created' } })).toBe(1);
  completed.push('valid-parent-positive');
});

it('keeps the explicit force override for a known duplicate', async () => {
  const name = prefix + '-intentional-duplicate';
  const first = await createOrganisation(author, { name });
  const second = await createOrganisation(author, { name, force: true });
  expect(first.id).not.toBe(second.id);
  expect(await db.organisation.count({ where: { workspaceId, name } })).toBe(2);
  expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: { in: [first.id, second.id] }, action: 'organisation.created' } })).toBe(2);
  completed.push('force-override-positive');
});

it('fails closed when current account row is being changed', async () => {
  const before = await snapshot();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
    await expect(createOrganisation(author, { name: prefix + '-locked-account' })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot()).toEqual(before);
  completed.push('account-lock-denied');
});

it('fails closed when current parent row is being changed', async () => {
  const parent = await db.organisation.create({ data: { workspaceId, name: prefix + '-locked-parent', createdById: author.id } });
  const before = await snapshot();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${parent.id} FOR UPDATE`;
    await expect(createOrganisation(author, { name: prefix + '-locked-child', parentId: parent.id })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot()).toEqual(before);
  completed.push('parent-lock-denied');
});
