// SHO-REG-PROJECTS-03: concurrent additions cannot turn seven sections into nine.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { addSection } from '@/lib/sections';
import { getOrCreateWorkspace } from '@/lib/workspace';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = `project-section-cap-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: 'MEMBER' as const };
const projectIds: string[] = [];
const transact = db.$transaction.bind(db);
let projectId = '';
let sentinelId = '';
let safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  const workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: leader.id, workspaceId, name: leader.id, email: `${leader.id}@example.invalid`, passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: leader.orgRole } });
  const project = await db.project.create({ data: { workspaceId, name: `${prefix}-subject` } });
  projectId = project.id; projectIds.push(projectId);
  await db.projectMember.create({ data: { projectId, userId: leader.id, role: 'LEADER' } });
  await db.section.createMany({ data: Array.from({ length: 7 }, (_, position) => ({ projectId, name: `${prefix}-${position}`, position, isDone: position === 6 })) });
  const sentinel = await db.project.create({ data: { workspaceId, name: `${prefix}-sentinel` } });
  sentinelId = sentinel.id; projectIds.push(sentinelId);
  await db.section.create({ data: { projectId: sentinelId, name: 'Sentinel', position: 0 } });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    await db.notification.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.delete({ where: { id: leader.id } });
    expect(await db.project.count({ where: { id: { in: projectIds } } })).toBe(0);
    expect(await db.user.count({ where: { id: leader.id } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/project-section-cap', { recursive: true });
    writeFileSync('test-results/project-section-cap/cleanup.json', JSON.stringify({ fixture: prefix, projectIds, userId: leader.id, cleanup }, null, 2));
  }
});

it('accepts one overlapping eighth section and rejects the ninth without changing unrelated rows', async () => {
  const sentinelBefore = await db.project.findUniqueOrThrow({ where: { id: sentinelId }, include: { sections: true } });
  let arrived = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived += 1;
    if (arrived === 2) release();
    await held;
    return transact(callback, options);
  }) as typeof db.$transaction);
  const safety = setTimeout(() => release(), 5000);
  const pending = Promise.allSettled([
    addSection(leader, projectId, `${prefix}-eighth-a`),
    addSection(leader, projectId, `${prefix}-eighth-b`),
  ]);
  try {
    await vi.waitFor(() => expect(arrived).toBe(2), { timeout: 5000 });
    const outcomes = await pending;
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const sections = await db.section.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
    expect(sections).toHaveLength(8);
    expect(sections.map(section => section.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await db.project.findUniqueOrThrow({ where: { id: sentinelId }, include: { sections: true } })).toEqual(sentinelBefore);
    mkdirSync('test-results/project-section-cap', { recursive: true });
    writeFileSync('test-results/project-section-cap/verification.json', JSON.stringify({ fixture: prefix, raced: 2, accepted: 1, rejected: 1, sectionCount: sections.length, positions: sections.map(s => s.position), sentinelPreserved: true }, null, 2));
  } finally {
    clearTimeout(safety);
    release();
    await pending;
    spy.mockRestore();
  }
});
