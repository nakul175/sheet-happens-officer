// Real PostgreSQL interleavings for ordinary CRM contact removal.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { removeContact } from '@/lib/records';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'contact-remove-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
let safe = false, workspaceId: string, organisationId: string, sentinelId: string;
const contacts: string[] = [], completed: string[] = [];
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of [author, admin]) await db.user.create({ data: { id: person.id, workspaceId, name: person.id, email: person.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: person.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  organisationId = (await db.organisation.create({ data: { workspaceId, name: prefix + '-org', createdById: author.id } })).id;
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
    await db.actionLog.deleteMany({ where: { targetType: 'contact', targetId: { in: contacts } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [author.id, admin.id] } } });
    await db.contactKnownBy.deleteMany({ where: { contactId: { in: contacts } } });
    await db.contact.deleteMany({ where: { id: { in: contacts } } });
    await db.organisation.delete({ where: { id: organisationId } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: [author.id, admin.id] } } });
    expect(await db.contact.count({ where: { id: { in: contacts } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/contact-remove', { recursive: true });
    writeFileSync('test-results/contact-remove/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'contact-remove-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const row = await db.contact.create({ data: { workspaceId, organisationId, name: prefix + '-person', createdById: author.id } });
  contacts.push(row.id);
  return row;
}
async function snapshot(id: string) {
  return {
    contact: await db.contact.findUniqueOrThrow({ where: { id } }),
    actions: await db.actionLog.findMany({ where: { targetType: 'contact', targetId: id }, orderBy: { id: 'asc' } }),
  };
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

it('refuses a deactivated author after preflight without removal or action', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([removeContact(author, row.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin removing another author’s contact after preflight', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([removeContact(admin, row.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('former-admin-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a contact already removed after preflight', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([removeContact(author, row.id)]);
  try {
    await pause.ready(); await db.contact.update({ where: { id: row.id }, data: { removedAt: new Date() } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('already-removed-denied');
  } finally { pause.release(); await pending; }
});

it('gives simultaneous removals one winner and one action', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([removeContact(author, row.id), removeContact(author, row.id)]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const after = await snapshot(row.id);
    expect(after.contact.removedAt).not.toBeNull();
    expect(after.actions.filter((item) => item.action === 'contact.removed')).toHaveLength(1);
    completed.push('concurrent-one-winner');
  } finally { pause.release(); await pending; }
});

it('allows the current author to remove once and logs the stored timestamp', async () => {
  const row = await fixture();
  await removeContact(author, row.id);
  const after = await snapshot(row.id);
  expect(after.contact.removedAt).not.toBeNull();
  const actions = after.actions.filter((item) => item.action === 'contact.removed');
  expect(actions).toHaveLength(1);
  expect(actions[0].afterState).toMatchObject({ removedAt: after.contact.removedAt?.toISOString() });
  completed.push('current-author-positive');
});

it('allows a current Admin to remove another author’s contact', async () => {
  const row = await fixture();
  await removeContact(admin, row.id);
  const after = await snapshot(row.id);
  expect(after.contact.removedAt).not.toBeNull();
  expect(after.actions.filter((item) => item.action === 'contact.removed' && item.actorId === admin.id)).toHaveLength(1);
  completed.push('current-admin-positive');
});

it('fails closed while the contact row is being changed', async () => {
  const row = await fixture(), before = await snapshot(row.id);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${row.id} FOR UPDATE`;
    await expect(removeContact(author, row.id)).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot(row.id)).toEqual(before);
  completed.push('contact-lock-denied');
});

it('fails closed while the author account is being changed', async () => {
  const row = await fixture(), before = await snapshot(row.id);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
    await expect(removeContact(author, row.id)).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot(row.id)).toEqual(before);
  completed.push('author-lock-denied');
});
