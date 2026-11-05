// Project member addition must use current actor, recipient and project facts at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { addMember } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-member-add-stale-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const people = [leader, admin, recipient], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
    await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: null } });
    await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null } });
  }
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-member-add-stale-race', { recursive: true });
    writeFileSync('test-results/project-member-add-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-member-add-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.create({ data: { projectId: project.id, userId: leader.id, role: 'LEADER' } });
  return project.id;
}
function pauseBeforeTransaction() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects an Admin whose organisation role was revoked after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addMember(admin, id, recipient.id, 'EDITOR')]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.projectMember.count({ where: { projectId: id, userId: recipient.id } })).toBe(0);
    completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects a Leader deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addMember(leader, id, recipient.id, 'EDITOR')]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.projectMember.count({ where: { projectId: id, userId: recipient.id } })).toBe(0);
    completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});

it('rejects a project archived after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addMember(leader, id, recipient.id, 'EDITOR')]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.projectMember.count({ where: { projectId: id, userId: recipient.id } })).toBe(0);
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('rejects a recipient deactivated after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addMember(leader, id, recipient.id, 'EDITOR')]);
  try {
    await pause.ready(); await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    expect(await db.projectMember.count({ where: { projectId: id, userId: recipient.id } })).toBe(0);
    completed.push('deactivated-recipient');
  } finally { pause.release(); await pending; }
});

it('notifies using the current project name after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([addMember(leader, id, recipient.id, 'EDITOR')]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { name: 'Fresh member project' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'fulfilled' })]);
    const notice = await db.notification.findFirstOrThrow({ where: { projectId: id, recipientId: recipient.id, type: 'ADDED_TO_PROJECT' } });
    expect(notice.data).toMatchObject({ project: 'Fresh member project' });
    completed.push('fresh-name');
  } finally { pause.release(); await pending; }
});

it('adds an eligible active person once', async () => {
  const id = await fixture();
  await addMember(leader, id, recipient.id, 'EDITOR');
  expect(await db.projectMember.count({ where: { projectId: id, userId: recipient.id, role: 'EDITOR' } })).toBe(1);
  expect(await db.actionLog.count({ where: { projectId: id, action: 'member.added' } })).toBe(1);
  completed.push('eligible-control');
});
