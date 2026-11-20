// A section update must recheck the actor and section after its preflight read.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { updateSection } from '@/lib/sections';
import { getOrCreateWorkspace } from '@/lib/workspace';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = `section-stale-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: 'MEMBER' as const };
const replacement = { id: `${prefix}-replacement`, orgRole: 'MEMBER' as const };
const users = [leader.id, replacement.id];
const projects: string[] = [];
const completed: string[] = [];
const transact = db.$transaction.bind(db);
let safe = false, workspaceId = '', sentinelId = '';

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, replacement]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: 'unused', emailVerifiedAt: new Date() } });
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: `${prefix}-sentinel` } })).id;
  projects.push(sentinelId);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(`${prefix}-sentinel`);
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/section-update-stale', { recursive: true });
    writeFileSync('test-results/section-update-stale/cleanup.json', JSON.stringify({ fixture: prefix, completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: `${prefix}-subject` } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: replacement.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const done = await db.section.create({ data: { projectId: project.id, name: 'Done', position: 1, isDone: true } });
  return { project, section, done };
}

function pauseBeforeTransaction() {
  let release!: () => void;
  let arrived = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects a former Leader after preflight without a section write or action row', async () => {
  const f = await fixture();
  const sentinel = await db.project.findUniqueOrThrow({ where: { id: sentinelId } });
  const pause = pauseBeforeTransaction();
  const pending = Promise.allSettled([updateSection(leader, f.project.id, f.section.id, { name: 'Unauthorized' })]);
  try {
    await pause.ready();
    await db.$transaction(async tx => {
      await tx.projectMember.update({ where: { projectId_userId: { projectId: f.project.id, userId: leader.id } }, data: { role: 'EDITOR' } });
      await tx.projectMember.update({ where: { projectId_userId: { projectId: f.project.id, userId: replacement.id } }, data: { role: 'LEADER' } });
    });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.section.findUniqueOrThrow({ where: { id: f.section.id } })).name).toBe('To do');
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'section.renamed' } })).toBe(0);
    expect(await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).toEqual(sentinel);
    completed.push('revoked-leader-no-write');
  } finally { pause.release(); await pending; }
});
