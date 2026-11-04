// Real PostgreSQL interleavings for projectless contact.created/contact.removed Undo.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-contact-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const foreignAdmin = { id: prefix + '-foreign', orgRole: 'ADMIN' as const };
const users: string[] = [], organisations: string[] = [], contacts: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, foreignWorkspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  foreignWorkspaceId = (await db.workspace.create({ data: { name: prefix + '-foreign' } })).id;
  for (const actor of [author, admin, foreignAdmin]) {
    await db.user.create({ data: { id: actor.id, workspaceId: actor.id === foreignAdmin.id ? foreignWorkspaceId : workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
    users.push(actor.id);
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
    await db.actionLog.deleteMany({ where: { targetType: 'contact', targetId: { in: contacts } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.contact.deleteMany({ where: { id: { in: contacts } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workspace.delete({ where: { id: foreignWorkspaceId } });
    expect(await db.contact.count({ where: { id: { in: contacts } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-contact', { recursive: true });
    writeFileSync('test-results/undo-contact/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'contact-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(action: 'contact.created' | 'contact.removed', actionActorId = author.id) {
  const org = await db.organisation.create({ data: { workspaceId, name: prefix + '-org', createdById: author.id } });
  organisations.push(org.id);
  const contact = await db.contact.create({ data: { workspaceId, organisationId: org.id, name: prefix + '-person', createdById: author.id, removedAt: action === 'contact.removed' ? new Date() : null } });
  contacts.push(contact.id);
  const log = await db.actionLog.create({ data: { actorId: actionActorId, projectId: null, targetType: 'contact', targetId: contact.id, channel: 'SCREEN', action, beforeState: action === 'contact.removed' ? { removedAt: null } : undefined, afterState: action === 'contact.created' ? { organisationId: org.id } : { removedAt: new Date().toISOString() }, createdAt: new Date(Date.now() - 2000) } });
  return { org, contact, log };
}
async function snapshot(contactId: string) {
  return { contact: await db.contact.findUniqueOrThrow({ where: { id: contactId } }), actions: await db.actionLog.findMany({ where: { targetType: 'contact', targetId: contactId }, orderBy: { id: 'asc' } }) };
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

it('refuses a deactivated author after preflight without deleting the contact or claiming its action', async () => {
  const f = await fixture('contact.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(author, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(f.contact.id); pause.release();
    const [result] = await pending, after = await snapshot(f.contact.id);
    const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    mkdirSync('test-results/undo-contact', { recursive: true });
    writeFileSync('test-results/undo-contact/verification.json', JSON.stringify({ actorDeactivated: true, denied, unchanged, contactRemoved: !!after.contact.removedAt, actionClaimed: !!after.actions.find((x) => x.id === f.log.id)?.undoneAt }, null, 2));
    expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
    completed.push('deactivation-after-preflight');
  } finally { pause.release(); await pending; }
});

it('refuses an Admin downgrade after preflight when undoing another person’s removal', async () => {
  const f = await fixture('contact.removed'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(admin, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(f.contact.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.contact.id)).toEqual(before);
    completed.push('admin-downgrade-after-preflight');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin who authored the removal but no longer may edit the contact', async () => {
  const f = await fixture('contact.removed', admin.id), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(admin, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(f.contact.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.contact.id)).toEqual(before);
    completed.push('former-admin-own-action-denied');
  } finally { pause.release(); await pending; }
});

it('keeps another workspace’s contact hidden from an Admin', async () => {
  const f = await fixture('contact.created'), before = await snapshot(f.contact.id);
  await expect(undoAction(foreignAdmin, f.log.id)).rejects.toMatchObject({ status: 404 });
  expect(await snapshot(f.contact.id)).toEqual(before);
  completed.push('cross-workspace-admin-denied');
});

it('gives concurrent contact Undo requests one winner and one activity', async () => {
  const f = await fixture('contact.created'), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(author, f.log.id), undoAction(author, f.log.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { targetType: 'contact', targetId: f.contact.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('rejects a contact already removed after preflight without claiming the action', async () => {
  const f = await fixture('contact.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(author, f.log.id)]);
  try {
    await pause.ready(); await db.contact.update({ where: { id: f.contact.id }, data: { removedAt: new Date() } });
    const before = await snapshot(f.contact.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.contact.id)).toEqual(before);
    completed.push('state-changed-after-preflight');
  } finally { pause.release(); await pending; }
});

it('allows an active author to undo a contact creation', async () => {
  const f = await fixture('contact.created');
  await undoAction(author, f.log.id);
  expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).removedAt).not.toBeNull();
  completed.push('author-positive');
});

it('allows an active author to restore a removed contact', async () => {
  const f = await fixture('contact.removed');
  await undoAction(author, f.log.id);
  expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).removedAt).toBeNull();
  completed.push('restore-positive');
});

it('allows a current Admin to restore another person’s removed contact', async () => {
  const f = await fixture('contact.removed');
  await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
  await undoAction(admin, f.log.id);
  expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).removedAt).toBeNull();
  expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.log.id } })).undoneById).toBe(admin.id);
  completed.push('admin-positive');
});

it('a competing contact row lock returns a retryable conflict and leaves Undo unchanged', async () => {
  const f = await fixture('contact.created'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${f.contact.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.contact.id);
    await expect(undoAction(author, f.log.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.contact.id)).toEqual(before);
    completed.push('contact-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(author, f.log.id);
  expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).removedAt).not.toBeNull();
});

it('activity failure rolls the inverse and claim back; retry succeeds', async () => {
  const f = await fixture('contact.created'), before = await snapshot(f.contact.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('CONTACT_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(author, f.log.id)).rejects.toThrow('CONTACT_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(f.contact.id)).toEqual(before);
  await undoAction(author, f.log.id);
  expect((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).removedAt).not.toBeNull();
  completed.push('activity-rollback-retry');
});
