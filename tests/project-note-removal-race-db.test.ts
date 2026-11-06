// Project-linked note deletion must recheck current visibility and be one-winner.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { removeNote } from '@/lib/records';
import { getOrCreateWorkspace } from '@/lib/workspace';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const fixtureId = `project-note-removal-${randomUUID()}`;
const leader = { id: `${fixtureId}-leader`, orgRole: 'MEMBER' as const };
const author = { id: `${fixtureId}-author`, orgRole: 'MEMBER' as const };
const admin = { id: `${fixtureId}-admin`, orgRole: 'ADMIN' as const };
const userIds = [leader.id, author.id, admin.id];
const projectIds: string[] = [], organisationIds: string[] = [], noteIds: string[] = [];
const completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, author, admin]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: `${fixtureId}-sentinel` } })).id;
  projectIds.push(sentinelId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: admin.id }, data: { orgRole: 'ADMIN' } });
});

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(`${fixtureId}-sentinel`);
    await db.notification.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.actionLog.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { targetType: 'note', targetId: { in: noteIds } }] } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.note.deleteMany({ where: { id: { in: noteIds } } });
    await db.dealParty.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.organisation.deleteMany({ where: { id: { in: organisationIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    expect(await db.note.count({ where: { id: { in: noteIds } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: userIds } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/project-note-removal', { recursive: true });
    writeFileSync('test-results/project-note-removal/cleanup.json', JSON.stringify({ fixture: fixtureId, projects: projectIds, organisations: organisationIds, notes: noteIds, completed, cleanup }, null, 2));
  }
});

async function seed() {
  const organisation = await db.organisation.create({ data: { workspaceId, name: `${fixtureId}-buyer`, createdById: author.id } });
  organisationIds.push(organisation.id);
  const project = await db.project.create({ data: { workspaceId, name: `${fixtureId}-deal`, typeId: 'wst_deal' } });
  projectIds.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: author.id, role: 'EDITOR' },
  ] });
  await db.dealParty.create({ data: { projectId: project.id, organisationId: organisation.id, role: 'BUYER' } });
  const note = await db.note.create({ data: { workspaceId, organisationId: organisation.id, projectId: project.id, kind: 'MEETING', date: new Date('2026-10-31T00:00:00Z'), text: `${fixtureId} private note`, authorId: author.id } });
  noteIds.push(note.id);
  return { project, note };
}

async function snapshot(id: string) {
  return {
    note: await db.note.findUniqueOrThrow({ where: { id } }),
    events: await db.actionLog.findMany({ where: { targetType: 'note', targetId: id }, orderBy: { id: 'asc' } }),
  };
}

const transact = db.$transaction.bind(db);
function pauseBeforeWrite(count: number) {
  let release!: () => void, arrived = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived++;
    await held;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() { await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 }); spy.mockRestore(); },
    release,
  };
}

it('rejects a former deal member who loses note visibility after preflight', async () => {
  const { project, note } = await seed();
  const pause = pauseBeforeWrite(1);
  const pending = Promise.allSettled([removeNote(author, note.id)]);
  try {
    await pause.ready();
    await db.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: author.id } } });
    const before = await snapshot(note.id);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(note.id)).toEqual(before);
    completed.push('removed-member-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('allows only one of two simultaneous removals and writes one activity event', async () => {
  const { note } = await seed();
  const pause = pauseBeforeWrite(2);
  const pending = Promise.allSettled([removeNote(author, note.id), removeNote(author, note.id)]);
  try {
    await pause.ready(); pause.release();
    const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const after = await snapshot(note.id);
    expect(after.note.removedAt).not.toBeNull();
    expect(after.events.filter((e) => e.action === 'note.removed')).toHaveLength(1);
    completed.push('duplicate-one-winner');
  } finally { pause.release(); await pending; }
}, 20_000);

it('rejects an Admin whose role is downgraded after preflight', async () => {
  const { note } = await seed();
  const pause = pauseBeforeWrite(1);
  const pending = Promise.allSettled([removeNote(admin, note.id)]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: admin.id }, data: { orgRole: 'MEMBER' } });
    const before = await snapshot(note.id);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 404 }) })]);
    expect(await snapshot(note.id)).toEqual(before);
    completed.push('admin-downgrade-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('rejects a note already removed after preflight without a duplicate event', async () => {
  const { note } = await seed();
  const pause = pauseBeforeWrite(1);
  const pending = Promise.allSettled([removeNote(author, note.id)]);
  try {
    await pause.ready();
    await db.note.update({ where: { id: note.id }, data: { removedAt: new Date() } });
    const before = await snapshot(note.id);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(note.id)).toEqual(before);
    completed.push('already-removed-after-preflight');
  } finally { pause.release(); await pending; }
}, 20_000);

it('allows the current Leader to remove another author’s note', async () => {
  const { note } = await seed();
  await removeNote(leader, note.id);
  const after = await snapshot(note.id);
  expect(after.note.removedAt).not.toBeNull();
  expect(after.events.filter((e) => e.action === 'note.removed')).toHaveLength(1);
  completed.push('leader-positive');
});
