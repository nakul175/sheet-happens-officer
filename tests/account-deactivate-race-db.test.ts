// Account deactivation authorization and handover interleavings on disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { deactivate } from '@/lib/team';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'deactivate-race-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const targets: string[] = [], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let safe = false, workspaceId: string, sentinelId: string;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [admin, leader]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN', deactivatedAt: null } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.auditLog.deleteMany({ where: { actorId: admin.id } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: [admin.id, leader.id, ...targets] } } });
    expect(await db.user.count({ where: { id: { in: targets } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/account-deactivate-race', { recursive: true });
    writeFileSync('test-results/account-deactivate-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'account-deactivate-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function target() {
  const id = prefix + '-target-' + targets.length; targets.push(id);
  await db.user.create({ data: { id, workspaceId, name: id, email: id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
  return id;
}
function pauseBeforeTransactions(count: number) {
  let release!: () => void, arrived = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); }, release };
}
async function auditCount(id: string) { return db.auditLog.count({ where: { targetId: id, event: 'USER_DEACTIVATED' } }); }

it('refuses an Admin who lost their organisation role after preflight', async () => {
  const id = await target(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    expect(await auditCount(id)).toBe(0); completed.push('former-admin-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a target promoted to Admin after an ordinary Admin preflight', async () => {
  const id = await target(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready(); await db.user.update({ where: { id }, data: { orgRole: 'ADMIN' } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    expect(await auditCount(id)).toBe(0); completed.push('new-admin-protected');
  } finally { pause.release(); await pending; }
});

it('refuses a deactivated Admin actor after preflight', async () => {
  const id = await target(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    expect(await auditCount(id)).toBe(0); completed.push('deactivated-actor-denied');
  } finally { pause.release(); await pending; }
});

it('refuses a person already deactivated after preflight', async () => {
  const id = await target(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready(); const marked = new Date(); await db.user.update({ where: { id }, data: { deactivatedAt: marked } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt?.getTime()).toBe(marked.getTime());
    expect(await auditCount(id)).toBe(0); completed.push('already-deactivated');
  } finally { pause.release(); await pending; }
});

it('hands over a task in a project joined after the membership preflight', async () => {
  const id = await target(), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready();
    const project = await db.project.create({ data: { workspaceId, name: prefix + '-late-project' } }); projects.push(project.id);
    await db.projectMember.createMany({ data: [{ projectId: project.id, userId: leader.id, role: 'LEADER' }, { projectId: project.id, userId: id, role: 'EDITOR' }] });
    const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
    const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Late work', assigneeId: id, createdById: leader.id } });
    pause.release();
    expect((await pending)[0]).toMatchObject({ status: 'fulfilled', value: { moved: 1 } });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(leader.id);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).not.toBeNull();
    completed.push('new-membership-handover');
  } finally { pause.release(); await pending; }
});

it('two deactivations of one person have one winner and one audit event', async () => {
  const id = await target(), pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([deactivate(admin, id, 'leaders'), deactivate(admin, id, 'leaders')]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(await auditCount(id)).toBe(1); completed.push('one-winner-deactivation');
  } finally { pause.release(); await pending; }
});

it('current Admin deactivates a member once and records the audit', async () => {
  const id = await target();
  expect(await deactivate(admin, id, 'leaders')).toEqual({ moved: 0, fellBack: [] });
  expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).not.toBeNull();
  expect(await auditCount(id)).toBe(1); completed.push('current-admin-control');
});

it('refuses target-account lock contention and succeeds after a safe retry', async () => {
  const id = await target();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
    reached(); await held;
  });
  try {
    await atLock;
    await expect(deactivate(admin, id, 'leaders')).rejects.toMatchObject({ status: 409 });
    expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    expect(await auditCount(id)).toBe(0);
  } finally { release(); await blocker; }
  await deactivate(admin, id, 'leaders');
  expect(await auditCount(id)).toBe(1);
  completed.push('locked-target-retry');
});
