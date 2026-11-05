// Change Leader must use current manager, candidate and project facts at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { changeLeader } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-leader-change-stale-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const candidate = { id: prefix + '-candidate', orgRole: 'MEMBER' as const };
const taker = { id: prefix + '-taker', orgRole: 'MEMBER' as const };
const people = [admin, leader, candidate, taker], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of people) await db.user.create({ data: { id: person.id, workspaceId, name: person.id, email: person.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: person.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) {
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
    await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: null } });
    await db.user.update({ where: { id: candidate.id }, data: { deactivatedAt: null } });
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
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: people.map(p => p.id) } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/project-leader-change-stale-race', { recursive: true });
    writeFileSync('test-results/project-leader-change-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-leader-change-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + randomUUID() } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [{ projectId: project.id, userId: leader.id, role: 'LEADER' }, { projectId: project.id, userId: candidate.id, role: 'EDITOR' }, { projectId: project.id, userId: taker.id, role: 'EDITOR' }] });
  return project.id;
}
async function assignedTask(projectId: string) {
  const section = await db.section.create({ data: { projectId, name: 'To do', position: 0 } });
  return db.task.create({ data: { workspaceId, projectId, sectionId: section.id, title: 'Leader work', assigneeId: leader.id, createdById: leader.id } });
}
function pauseBeforeTransaction() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}
async function roles(id: string) {
  const rows = await db.projectMember.findMany({ where: { projectId: id }, select: { userId: true, role: true } });
  return Object.fromEntries(rows.map(r => [r.userId, r.role]));
}
const change = (actor: typeof admin | typeof leader, id: string) => changeLeader(actor, id, { newLeaderId: candidate.id, previousRole: 'EDITOR' });

it('rejects a revoked Admin after Change Leader preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([change(admin, id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' }); completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});
it('rejects a deactivated Leader after Change Leader preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([change(leader, id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' }); completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});
it('rejects an archived project after Change Leader preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([change(admin, id)]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' }); completed.push('archived-project');
  } finally { pause.release(); await pending; }
});
it('rejects a deactivated successor after Change Leader preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([change(admin, id)]);
  try {
    await pause.ready(); await db.user.update({ where: { id: candidate.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' }); completed.push('deactivated-successor');
  } finally { pause.release(); await pending; }
});
it('uses the current project name in Change Leader notices', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([change(admin, id)]);
  try {
    await pause.ready(); await db.project.update({ where: { id }, data: { name: 'Fresh leadership project ' + randomUUID() } }); pause.release();
    await pending;
    const notice = await db.notification.findFirstOrThrow({ where: { projectId: id, recipientId: candidate.id, type: 'MADE_LEADER' } });
    expect(notice.data).toMatchObject({ project: (await db.project.findUniqueOrThrow({ where: { id } })).name });
    completed.push('fresh-name');
  } finally { pause.release(); await pending; }
});
it('changes an eligible Leader once', async () => {
  const id = await fixture(); await change(admin, id);
  expect(await roles(id)).toMatchObject({ [leader.id]: 'EDITOR', [candidate.id]: 'LEADER' });
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.leader_changed' } })).toBe(1);
  completed.push('valid-control');
});
it('returns a retryable conflict on a locked project, then changes the Leader once', async () => {
  const id = await fixture();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = transact(async tx => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR UPDATE`; reached(); await held; });
  const safety = setTimeout(() => release(), 500);
  try {
    await atLock;
    await expect(change(admin, id)).rejects.toMatchObject({ status: 409 });
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' });
  } finally { clearTimeout(safety); release(); await blocker; }
  await change(admin, id);
  expect(await roles(id)).toMatchObject({ [leader.id]: 'EDITOR', [candidate.id]: 'LEADER' });
  expect(await db.actionLog.count({ where: { projectId: id, action: 'project.leader_changed' } })).toBe(1);
  completed.push('locked-project-retry');
}, 20_000);

it('requires a handover choice when a task appears after removal preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([changeLeader(admin, id, { newLeaderId: candidate.id, previousRole: 'REMOVE' })]);
  try {
    await pause.ready(); const task = await assignedTask(id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await roles(id)).toMatchObject({ [leader.id]: 'LEADER', [candidate.id]: 'EDITOR' });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(leader.id);
    completed.push('new-task-requires-choice');
  } finally { pause.release(); await pending; }
});
it('honours the selected handover taker for a task appearing after preflight', async () => {
  const id = await fixture(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([changeLeader(admin, id, { newLeaderId: candidate.id, previousRole: 'REMOVE', handoverTo: taker.id })]);
  try {
    await pause.ready(); const task = await assignedTask(id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'fulfilled' })]);
    expect(await roles(id)).toMatchObject({ [candidate.id]: 'LEADER', [taker.id]: 'EDITOR' });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(taker.id);
    completed.push('new-task-selected-taker');
  } finally { pause.release(); await pending; }
});
it('hands work to the successor when the previous Leader becomes Viewer', async () => {
  const id = await fixture(), task = await assignedTask(id);
  await changeLeader(admin, id, { newLeaderId: candidate.id, previousRole: 'VIEWER', handoverTo: candidate.id });
  expect(await roles(id)).toMatchObject({ [leader.id]: 'VIEWER', [candidate.id]: 'LEADER' });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(candidate.id);
  completed.push('viewer-handover');
});
it('removes the previous Leader and hands work to a chosen Editor', async () => {
  const id = await fixture(), task = await assignedTask(id);
  await changeLeader(admin, id, { newLeaderId: candidate.id, previousRole: 'REMOVE', handoverTo: taker.id });
  const seats = await roles(id);
  expect(seats[leader.id]).toBeUndefined();
  expect(seats).toMatchObject({ [candidate.id]: 'LEADER', [taker.id]: 'EDITOR' });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(taker.id);
  completed.push('remove-handover');
});
