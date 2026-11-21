// Real PostgreSQL access/replay interleavings for projectless deal-note Undo.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { removeMember } from '@/lib/projects';
import { undoAction } from '@/lib/undo';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'undo-note-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const users: string[] = [], projects: string[] = [], organisations: string[] = [], notes: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor, admin]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
    users.push(actor.id);
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
    await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: null } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { OR: [{ projectId: { in: projects } }, { targetType: 'note', targetId: { in: notes } }] } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.note.deleteMany({ where: { id: { in: notes } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.note.count({ where: { id: { in: notes } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-note', { recursive: true });
    writeFileSync('test-results/undo-note/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'deal-note-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(action: 'note.created' | 'note.removed', dealLinked = true) {
  const organisation = await db.organisation.create({ data: { workspaceId, name: prefix + '-buyer', createdById: editor.id } });
  organisations.push(organisation.id);
  const deal = dealLinked ? await db.project.create({ data: { workspaceId, name: prefix + '-deal', typeId: 'wst_deal' } }) : null;
  if (deal) {
    projects.push(deal.id);
    await db.projectMember.createMany({ data: [
      { projectId: deal.id, userId: leader.id, role: 'LEADER' },
      { projectId: deal.id, userId: editor.id, role: 'EDITOR' },
    ] });
    await db.dealParty.create({ data: { projectId: deal.id, organisationId: organisation.id, role: 'BUYER' } });
  }
  const note = await db.note.create({ data: { workspaceId, organisationId: organisation.id, projectId: deal?.id ?? null, kind: 'MEETING', date: new Date('2026-10-31T00:00:00Z'), text: 'Owned test note', authorId: editor.id, removedAt: action === 'note.removed' ? new Date() : null } });
  notes.push(note.id);
  const log = await db.actionLog.create({ data: { actorId: editor.id, projectId: null, targetType: 'note', targetId: note.id, channel: 'SCREEN', action, beforeState: action === 'note.removed' ? { removedAt: null } : undefined, afterState: action === 'note.created' ? { organisationId: organisation.id, dealId: deal?.id ?? null } : { removedAt: new Date().toISOString() }, createdAt: new Date(Date.now() - 2000) } });
  return { organisation, deal, note, log };
}
async function snapshot(noteId: string) {
  return {
    note: await db.note.findUniqueOrThrow({ where: { id: noteId } }),
    actions: await db.actionLog.findMany({ where: { targetType: 'note', targetId: noteId }, orderBy: { id: 'asc' } }),
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

it.each(['note.created', 'note.removed'] as const)('hides %s Undo after its author loses the deal seat', async (kind) => {
  const f = await fixture(kind);
  await removeMember(leader, f.deal!.id, editor.id);
  const before = await snapshot(f.note.id);
  const result = await Promise.allSettled([undoAction(editor, f.log.id)]);
  const after = await snapshot(f.note.id);
  const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  if (kind === 'note.created') {
    mkdirSync('test-results/undo-note', { recursive: true });
    writeFileSync('test-results/undo-note/verification.json', JSON.stringify({ actorRemoved: true, denied, unchanged, noteRemoved: !!after.note.removedAt, actionClaimed: !!after.actions.find((row) => row.id === f.log.id)?.undoneAt }, null, 2));
  }
  expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
  completed.push(kind + '-removed-actor');
});

it('rechecks note visibility after Undo preflight before soft-deleting it', async () => {
  const f = await fixture('note.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.log.id)]);
  try {
    await pause.ready(); await removeMember(leader, f.deal!.id, editor.id);
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('two simultaneous note Undo requests have one winner and one activity', async () => {
  const f = await fixture('note.created'), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([undoAction(editor, f.log.id), undoAction(editor, f.log.id)]);
  try {
    await pause.ready(); pause.release(); const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).not.toBeNull();
    expect(await db.actionLog.count({ where: { targetType: 'note', targetId: f.note.id, action: 'undo' } })).toBe(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
});

it('rejects an already-removed note changed after preflight without claiming the action', async () => {
  const f = await fixture('note.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.log.id)]);
  try {
    await pause.ready(); await db.note.update({ where: { id: f.note.id }, data: { removedAt: new Date() } });
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('changed-after-preflight');
  } finally { pause.release(); await pending; }
});

it('an ordinary unlinked note can still be undone by its author', async () => {
  const f = await fixture('note.created', false);
  await undoAction(editor, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).not.toBeNull();
  completed.push('unlinked-note-positive');
});

it('an Admin can undo a deal note after its author loses the deal seat', async () => {
  const f = await fixture('note.created');
  await removeMember(leader, f.deal!.id, editor.id);
  await undoAction(admin, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).not.toBeNull();
  expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.log.id } })).undoneById).toBe(admin.id);
  completed.push('admin-positive');
});

it('a competing deal-membership row lock returns a retryable conflict without changing the note', async () => {
  const f = await fixture('note.created'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => { await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${f.deal!.id} AND "userId" = ${editor.id} FOR UPDATE`; locked = true; await held; }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.note.id);
    await expect(undoAction(editor, f.log.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('membership-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).not.toBeNull();
});

it('activity failure rolls note inverse and claim back; retry succeeds', async () => {
  const f = await fixture('note.created'), before = await snapshot(f.note.id);
  vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
    const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('NOTE_UNDO_ACTIVITY_FAILURE'));
    try { return await callback(tx); } finally { create.mockRestore(); }
  })) as typeof db.$transaction);
  await expect(undoAction(editor, f.log.id)).rejects.toThrow('NOTE_UNDO_ACTIVITY_FAILURE');
  vi.restoreAllMocks();
  expect(await snapshot(f.note.id)).toEqual(before);
  await undoAction(editor, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).not.toBeNull();
  completed.push('activity-rollback-retry');
});

it('rechecks an Admin downgrade before Undoing another person’s deal note', async () => {
  const f = await fixture('note.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(admin, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('admin-downgrade-after-preflight');
  } finally { pause.release(); await pending; }
});

it('refuses a note Undo after its author is deactivated during preflight', async () => {
  const f = await fixture('note.created'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: new Date() } });
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('author-deactivated-after-preflight');
  } finally { pause.release(); await pending; }
});

it('refuses a former deal Leader who removed another author’s note after losing Leader rights', async () => {
  const f = await fixture('note.removed');
  await db.actionLog.update({ where: { id: f.log.id }, data: { actorId: leader.id } });
  const pause = pauseBeforeTransactions(1), pending = Promise.allSettled([undoAction(leader, f.log.id)]);
  try {
    await pause.ready();
    await transact(async (tx) => {
      await tx.projectMember.update({ where: { projectId_userId: { projectId: f.deal!.id, userId: leader.id } }, data: { role: 'EDITOR' } });
      await tx.projectMember.update({ where: { projectId_userId: { projectId: f.deal!.id, userId: editor.id } }, data: { role: 'LEADER' } });
    });
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('former-leader-own-removal-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a former Admin who removed another author’s unlinked note', async () => {
  const f = await fixture('note.removed', false);
  await db.actionLog.update({ where: { id: f.log.id }, data: { actorId: admin.id } });
  const pause = pauseBeforeTransactions(1), pending = Promise.allSettled([undoAction(admin, f.log.id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(f.note.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.note.id)).toEqual(before);
    completed.push('former-admin-own-removal-denied');
  } finally { pause.release(); await pending; }
});

it('allows a current deal Leader to restore another author’s removed note', async () => {
  const f = await fixture('note.removed');
  await db.actionLog.update({ where: { id: f.log.id }, data: { actorId: leader.id } });
  await undoAction(leader, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).toBeNull();
  completed.push('current-leader-positive');
});

it('does not treat a deal creator with an Editor seat as the note Leader', async () => {
  const f = await fixture('note.removed');
  await db.actionLog.update({ where: { id: f.log.id }, data: { actorId: leader.id } });
  await db.actionLog.create({ data: { actorId: leader.id, projectId: f.deal!.id, targetType: 'project', targetId: f.deal!.id, channel: 'SCREEN', action: 'project.created' } });
  await db.projectMember.update({ where: { projectId_userId: { projectId: f.deal!.id, userId: leader.id } }, data: { role: 'EDITOR' } });
  const before = await snapshot(f.note.id);
  await expect(undoAction(leader, f.log.id)).rejects.toMatchObject({ status: 403 });
  expect(await snapshot(f.note.id)).toEqual(before);
  completed.push('creator-editor-not-note-leader');
});

it('still allows the author to restore their note after losing a Leader seat', async () => {
  const f = await fixture('note.removed');
  await db.projectMember.update({ where: { projectId_userId: { projectId: f.deal!.id, userId: editor.id } }, data: { role: 'VIEWER' } });
  await undoAction(editor, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).toBeNull();
  completed.push('author-viewer-positive');
});

it('allows a current Admin to restore another author’s unlinked note', async () => {
  const f = await fixture('note.removed', false);
  await db.actionLog.update({ where: { id: f.log.id }, data: { actorId: admin.id } });
  await undoAction(admin, f.log.id);
  expect((await db.note.findUniqueOrThrow({ where: { id: f.note.id } })).removedAt).toBeNull();
  completed.push('unlinked-admin-positive');
});
