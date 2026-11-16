// Real PostgreSQL interleavings for ordinary CRM contact creation.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { createContact } from '@/lib/records';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'contact-create-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
let safe = false, workspaceId: string, organisationId: string, sentinelId: string;
const completed: string[] = [];
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of [author, recipient]) await db.user.create({ data: { id: person.id, workspaceId, name: person.id, email: person.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: person.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  organisationId = (await db.organisation.create({ data: { workspaceId, name: prefix + '-org', createdById: author.id } })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: author.id }, data: { deactivatedAt: null } });
    await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null, emailVerifiedAt: new Date() } });
    await db.organisation.update({ where: { id: organisationId }, data: { archivedAt: null } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    const ids = (await db.contact.findMany({ where: { organisationId, name: { startsWith: prefix } }, select: { id: true } })).map((row) => row.id);
    await db.actionLog.deleteMany({ where: { targetType: 'contact', targetId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [author.id, recipient.id] } } });
    await db.contactKnownBy.deleteMany({ where: { contactId: { in: ids } } });
    await db.contact.deleteMany({ where: { id: { in: ids } } });
    await db.organisation.delete({ where: { id: organisationId } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: [author.id, recipient.id] } } });
    expect(await db.contact.count({ where: { organisationId } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/contact-create', { recursive: true });
    writeFileSync('test-results/contact-create/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'contact-create-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function snapshot() {
  const contacts = await db.contact.findMany({ where: { organisationId, name: { startsWith: prefix } }, orderBy: { id: 'asc' } });
  const ids = contacts.map((row) => row.id);
  return {
    contacts,
    knownBy: await db.contactKnownBy.findMany({ where: { contactId: { in: ids } }, orderBy: [{ contactId: 'asc' }, { userId: 'asc' }] }),
    actions: await db.actionLog.findMany({ where: { targetType: 'contact', targetId: { in: ids } }, orderBy: { id: 'asc' } }),
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

it('refuses a deactivated author after create preflight without a contact or action', async () => {
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createContact(author, organisationId, { name: prefix + '-deactivated-author' })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('deactivated-author-denied');
  } finally { pause.release(); await pending; }
});

it('refuses to add a contact after its organisation was archived', async () => {
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createContact(author, organisationId, { name: prefix + '-archived-org' })]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: organisationId }, data: { archivedAt: new Date() } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('archived-organisation-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a Known by recipient deactivated after create preflight', async () => {
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createContact(author, organisationId, { name: prefix + '-departed-recipient', knownBy: [recipient.id] })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('deactivated-recipient-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a Known by recipient whose email verification was revoked after preflight', async () => {
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([createContact(author, organisationId, { name: prefix + '-unverified-recipient', knownBy: [recipient.id] })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: recipient.id }, data: { emailVerifiedAt: null } });
    const before = await snapshot(); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot()).toEqual(before);
    completed.push('unverified-recipient-denied');
  } finally { pause.release(); await pending; }
});

it('allows a current author and eligible Known by recipient with one action', async () => {
  const row = await createContact(author, organisationId, { name: prefix + '-valid', knownBy: [recipient.id] });
  expect((await db.contact.findUniqueOrThrow({ where: { id: row.id } })).name).toBe(prefix + '-valid');
  expect((await db.contactKnownBy.findMany({ where: { contactId: row.id } })).map((item) => item.userId)).toEqual([recipient.id]);
  expect(await db.actionLog.count({ where: { targetType: 'contact', targetId: row.id, action: 'contact.created' } })).toBe(1);
  completed.push('current-author-recipient-positive');
});

it('keeps the author as the default Known by person', async () => {
  const row = await createContact(author, organisationId, { name: prefix + '-default-recipient' });
  expect((await db.contactKnownBy.findMany({ where: { contactId: row.id } })).map((item) => item.userId)).toEqual([author.id]);
  expect(await db.actionLog.count({ where: { targetType: 'contact', targetId: row.id, action: 'contact.created' } })).toBe(1);
  completed.push('default-author-recipient-positive');
});

it('fails closed while the organisation is being changed', async () => {
  const before = await snapshot();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organisationId} FOR UPDATE`;
    await expect(createContact(author, organisationId, { name: prefix + '-locked-org' })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot()).toEqual(before);
  completed.push('organisation-lock-denied');
});

it('fails closed while the author account is being changed', async () => {
  const before = await snapshot();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
    await expect(createContact(author, organisationId, { name: prefix + '-locked-author' })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot()).toEqual(before);
  completed.push('author-lock-denied');
});

it('fails closed while a proposed Known by recipient is being changed', async () => {
  const before = await snapshot();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${recipient.id} FOR UPDATE`;
    await expect(createContact(author, organisationId, { name: prefix + '-locked-recipient', knownBy: [recipient.id] })).rejects.toMatchObject({ status: 409 });
  });
  expect(await snapshot()).toEqual(before);
  completed.push('recipient-lock-denied');
});
