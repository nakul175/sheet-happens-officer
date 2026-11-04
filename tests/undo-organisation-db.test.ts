// Real PostgreSQL interleavings for projectless organisation create/archive Undo.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { undoAction } from '@/lib/undo';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-organisation-' + randomUUID();
const author = { id: prefix + '-author', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const foreignAdmin = { id: prefix + '-foreign', orgRole: 'ADMIN' as const };
const users: string[] = [], organisations: string[] = [], completed: string[] = [];
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
    await db.actionLog.deleteMany({ where: { targetType: 'organisation', targetId: { in: organisations } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.project.delete({ where: { id: sentinelId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workspace.delete({ where: { id: foreignWorkspaceId } });
    expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-organisation', { recursive: true });
    writeFileSync('test-results/undo-organisation/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'organisation-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});
type Kind = 'organisation.created' | 'organisation.archived' | 'organisation.unarchived';
async function fixture(action: Kind) {
  const archivedAt = action === 'organisation.archived' ? new Date() : null;
  const organisation = await db.organisation.create({ data: { workspaceId, name: prefix + '-buyer', createdById: author.id, archivedAt } });
  organisations.push(organisation.id);
  const log = await db.actionLog.create({ data: { actorId: author.id, projectId: null, targetType: 'organisation', targetId: organisation.id, channel: 'SCREEN', action, beforeState: { archivedAt: action === 'organisation.unarchived' ? new Date().toISOString() : null }, afterState: { archivedAt: archivedAt?.toISOString() ?? null }, createdAt: new Date(Date.now() - 2000) } });
  return { organisation, log };
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

it('refuses a deactivated author after preflight without archiving or claiming the action', async () => {
  const f = await fixture('organisation.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(author, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: author.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(f.organisation.id); pause.release();
    const [result] = await pending, after = await snapshot(f.organisation.id);
    const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    mkdirSync('test-results/undo-organisation', { recursive: true });
    writeFileSync('test-results/undo-organisation/verification.json', JSON.stringify({ actorDeactivated: true, denied, unchanged, organisationArchived: !!after.organisation.archivedAt, actionClaimed: !!after.actions.find((x) => x.id === f.log.id)?.undoneAt }, null, 2));
    expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
    completed.push('deactivation-after-preflight');
  } finally { pause.release(); await pending; }
});

it('refuses an Admin downgrade after preflight when undoing another person’s archive', async () => {
  const f = await fixture('organisation.archived'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(admin, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(f.organisation.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.organisation.id)).toEqual(before);
    completed.push('admin-downgrade-after-preflight');
  } finally { pause.release(); await pending; }
});

it('keeps another workspace’s organisation hidden from an Admin', async () => {
  const f = await fixture('organisation.created'), before = await snapshot(f.organisation.id);
  await expect(undoAction(foreignAdmin, f.log.id)).rejects.toMatchObject({ status: 404 });
  expect(await snapshot(f.organisation.id)).toEqual(before);
  completed.push('cross-workspace-admin-denied');
});

it('gives concurrent organisation Undo requests one winner and one activity', async () => {
  const f = await fixture('organisation.created'), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(author, f.log.id), undoAction(author, f.log.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.actionLog.count({ where: { targetType: 'organisation', targetId: f.organisation.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('rejects an organisation archived after preflight without claiming the original action', async () => {
  const f = await fixture('organisation.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(author, f.log.id)]);
  try {
    await pause.ready(); await db.organisation.update({ where: { id: f.organisation.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(f.organisation.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.organisation.id)).toEqual(before);
    completed.push('state-changed-after-preflight');
  } finally { pause.release(); await pending; }
});

it.each(['organisation.created', 'organisation.archived', 'organisation.unarchived'] as const)('allows an active author to Undo %s', async (kind) => {
  const f = await fixture(kind);
  await undoAction(author, f.log.id);
  const archived = !!(await db.organisation.findUniqueOrThrow({ where: { id: f.organisation.id } })).archivedAt;
  expect(archived).toBe(kind !== 'organisation.archived');
  completed.push(kind + '-author-positive');
});
