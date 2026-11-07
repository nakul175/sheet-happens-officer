// Real PostgreSQL interleavings for ordinary CRM contact updates.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { updateContact } from '@/lib/records';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'contact-update-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const users = [author, admin, recipient];
const contacts: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, orgId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of users) await db.user.create({ data: { id: person.id, workspaceId, name: person.id, email: person.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: person.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  orgId = (await db.organisation.create({ data: { workspaceId, name: prefix + '-org', createdById: author.id } })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: author.id }, data: { deactivatedAt: null } });
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
    await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.actionLog.deleteMany({ where: { targetType: 'contact', targetId: { in: contacts } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users.map((x) => x.id) } } });
    await db.contactKnownBy.deleteMany({ where: { contactId: { in: contacts } } });
    await db.contact.deleteMany({ where: { id: { in: contacts } } });
    await db.organisation.delete({ where: { id: orgId } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: users.map((x) => x.id) } } });
    expect(await db.contact.count({ where: { id: { in: contacts } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/contact-update', { recursive: true });
    writeFileSync('test-results/contact-update/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'contact-update-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(createdById = author.id) {
  const row = await db.contact.create({ data: { workspaceId, organisationId: orgId, name: prefix + '-old', createdById } });
  contacts.push(row.id);
  await db.contactKnownBy.create({ data: { contactId: row.id, userId: createdById } });
  return row;
}
async function snapshot(id: string) {
  return {
    contact: await db.contact.findUniqueOrThrow({ where: { id } }),
    knownBy: await db.contactKnownBy.findMany({ where: { contactId: id }, orderBy: { userId: 'asc' } }),
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

it('refuses a deactivated author after preflight without changing contact or action', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateContact(author, row.id, { name: prefix + '-new' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin editing another author’s contact after preflight', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateContact(admin, row.id, { name: prefix + '-admin-edit' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('former-admin-denied');
  } finally { pause.release(); await pending; }
});

it('refuses an update after the contact was removed', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateContact(author, row.id, { role: 'new role' })]);
  try {
    await pause.ready(); await db.contact.update({ where: { id: row.id }, data: { removedAt: new Date() } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('removed-contact-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a Known by recipient deactivated after preflight', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([updateContact(author, row.id, { knownBy: [recipient.id] })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(row.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(row.id)).toEqual(before);
    completed.push('deactivated-recipient-denied');
  } finally { pause.release(); await pending; }
});

it('gives competing edits of the same contact one winner and one action', async () => {
  const row = await fixture(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([
    updateContact(author, row.id, { name: prefix + '-first' }),
    updateContact(author, row.id, { name: prefix + '-second' }),
  ]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const after = await snapshot(row.id);
    expect([prefix + '-first', prefix + '-second']).toContain(after.contact.name);
    expect(after.actions.filter((x) => x.action === 'contact.updated')).toHaveLength(1);
    completed.push('competing-edits-one-winner');
  } finally { pause.release(); await pending; }
});

it('allows the current author to update one contact with one action', async () => {
  const row = await fixture();
  const updated = await updateContact(author, row.id, { name: prefix + '-valid' });
  expect(updated.name).toBe(prefix + '-valid');
  expect((await snapshot(row.id)).actions.filter((x) => x.action === 'contact.updated')).toHaveLength(1);
  completed.push('current-author-positive');
});

it('allows a current Known by recipient and logs the exact change', async () => {
  const row = await fixture();
  await updateContact(author, row.id, { knownBy: [recipient.id] });
  const after = await snapshot(row.id);
  expect(after.knownBy.map((item) => item.userId)).toEqual([recipient.id]);
  expect(after.actions.filter((item) => item.action === 'contact.updated')).toHaveLength(1);
  completed.push('current-recipient-positive');
});

it('fails closed while the contact row is being changed', async () => {
  const row = await fixture(), before = await snapshot(row.id);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${row.id} FOR UPDATE`;
    await expect(updateContact(author, row.id, { name: prefix + '-locked-contact' })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot(row.id)).toEqual(before);
  completed.push('contact-lock-denied');
});

it('fails closed while the author account is being changed', async () => {
  const row = await fixture(), before = await snapshot(row.id);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
    await expect(updateContact(author, row.id, { name: prefix + '-locked-author' })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot(row.id)).toEqual(before);
  completed.push('author-lock-denied');
});

it('fails closed while a proposed Known by recipient is being changed', async () => {
  const row = await fixture(), before = await snapshot(row.id);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${recipient.id} FOR UPDATE`;
    await expect(updateContact(author, row.id, { knownBy: [recipient.id] })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot(row.id)).toEqual(before);
  completed.push('recipient-lock-denied');
});
