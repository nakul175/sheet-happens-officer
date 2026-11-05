// Project creation must use current actor, people and vertical state at commit.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { createProject } from '@/lib/projects';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'project-create-stale-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const creator = { id: prefix + '-creator', orgRole: 'MEMBER' as const };
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const people = [admin, creator, leader, recipient], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, verticalId: string, sentinelId: string, safe = false;
const name = () => prefix + '-' + randomUUID();

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of people) {
    await db.user.create({ data: { id: person.id, workspaceId, name: person.id, email: person.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: person.orgRole } });
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  verticalId = (await db.project.create({ data: { workspaceId, name: prefix + '-vertical', isVertical: true } })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!safe) return;
  await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
  await db.user.update({ where: { id: creator.id }, data: { deactivatedAt: null } });
  await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: null } });
  await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null } });
  await db.project.update({ where: { id: verticalId }, data: { archivedAt: null, isVertical: true } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    const ids = (await db.project.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } })).map(p => p.id);
    await db.notification.deleteMany({ where: { projectId: { in: ids } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: ids } } });
    await db.project.updateMany({ where: { id: { in: ids } }, data: { verticalId: null } });
    await db.project.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { name: { startsWith: prefix } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/project-create-stale-race', { recursive: true });
    writeFileSync('test-results/project-create-stale-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'project-create-disposable-postgres', completed, cleanup }, null, 2));
  }
});
function pauseBeforeTransaction() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}
async function expectNoProject(projectName: string) {
  expect(await db.project.count({ where: { workspaceId, name: projectName } })).toBe(0);
}

it('rejects a vertical creation after Admin role revocation', async () => {
  const projectName = name(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createProject(admin, { name: projectName, leaderId: leader.id, isVertical: true })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    await expectNoProject(projectName); completed.push('revoked-admin');
  } finally { pause.release(); await pending; }
});

it('rejects creation after actor deactivation', async () => {
  const projectName = name(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createProject(creator, { name: projectName, leaderId: leader.id })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: creator.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    await expectNoProject(projectName); completed.push('deactivated-actor');
  } finally { pause.release(); await pending; }
});

it('rejects a Leader deactivated after preflight', async () => {
  const projectName = name(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createProject(admin, { name: projectName, leaderId: leader.id })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: leader.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    await expectNoProject(projectName); completed.push('deactivated-leader');
  } finally { pause.release(); await pending; }
});

it('rejects a recipient deactivated after preflight', async () => {
  const projectName = name(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createProject(admin, { name: projectName, leaderId: leader.id, members: [{ userId: recipient.id, role: 'EDITOR' }] })]);
  try {
    await pause.ready(); await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    await expectNoProject(projectName); completed.push('deactivated-recipient');
  } finally { pause.release(); await pending; }
});

it('rejects a vertical archived after preflight', async () => {
  const projectName = name(), pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([createProject(admin, { name: projectName, leaderId: leader.id, verticalId })]);
  try {
    await pause.ready(); await db.project.update({ where: { id: verticalId }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 400 }) })]);
    await expectNoProject(projectName); completed.push('archived-vertical');
  } finally { pause.release(); await pending; }
});

it('creates a valid delivery board and seats active people once', async () => {
  const projectName = name();
  const project = await createProject(admin, { name: projectName, leaderId: leader.id, verticalId, members: [{ userId: recipient.id, role: 'EDITOR' }] });
  expect(project.verticalId).toBe(verticalId);
  expect(await db.projectMember.count({ where: { projectId: project.id } })).toBe(3);
  expect(await db.section.count({ where: { projectId: project.id } })).toBe(3);
  completed.push('valid-control');
});

it('returns a retryable conflict on a locked vertical, then creates once', async () => {
  const projectName = name();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = transact(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${verticalId} FOR UPDATE`;
    reached(); await held;
  });
  const safety = setTimeout(() => release(), 15_000);
  try {
    await atLock;
    await expect(createProject(admin, { name: projectName, leaderId: leader.id, verticalId })).rejects.toMatchObject({ status: 409 });
    await expectNoProject(projectName);
  } finally { clearTimeout(safety); release(); await blocker; }
  await createProject(admin, { name: projectName, leaderId: leader.id, verticalId });
  expect(await db.project.count({ where: { workspaceId, name: projectName } })).toBe(1);
  completed.push('locked-vertical-retry');
}, 20_000);
