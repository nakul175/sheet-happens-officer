// A saved-view cap must hold when two requests compete for the tenth slot.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { createView } from '@/lib/views';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const fixture = `project-saved-view-race-${randomUUID()}`;
const actor = { id: `${fixture}-leader`, orgRole: 'MEMBER' as const };
const state = { assignee: '', flags: [] as ('overdue' | 'blocked' | 'awaiting' | 'nodate')[], priority: '' as const, sort: 'date' as const, group: 'section' as const };
let workspaceId: string, projectId: string, sentinelId: string, safe = false, cleanup = false;
const completed: string[] = [];

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: fixture, email: `${fixture}@example.invalid`, passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: `${fixture}-sentinel` } })).id;
  projectId = (await db.project.create({ data: { workspaceId, name: fixture } })).id;
  await db.projectMember.create({ data: { projectId, userId: actor.id, role: 'LEADER' } });
  for (let i = 0; i < 9; i++) await db.savedView.create({ data: { userId: actor.id, projectId, name: `V${i}`, state, position: i } });
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (!safe) return;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(`${fixture}-sentinel`);
    await db.savedView.deleteMany({ where: { userId: actor.id } });
    await db.projectMember.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: { in: [projectId, sentinelId] } } });
    await db.user.delete({ where: { id: actor.id } });
    expect(await db.savedView.count({ where: { userId: actor.id } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/project-saved-views-cap-race', { recursive: true });
    writeFileSync('test-results/project-saved-views-cap-race/cleanup.json', JSON.stringify({ fixture, completed, cleanup }, null, 2));
  }
});

it('keeps at most ten views when two creates compete for the tenth slot', async () => {
  const results = await Promise.allSettled([
    createView(actor, projectId, { name: 'A', state }),
    createView(actor, projectId, { name: 'B', state }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
  ]);
  expect(await db.savedView.count({ where: { userId: actor.id, projectId } })).toBe(10);
  completed.push('concurrent-cap-one-winner');
}, 20_000);
