// Disposable PostgreSQL race for two requests converting the same task.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { convertTaskToDeal } from '@/lib/deals';
import { getOrCreateWorkspace } from '@/lib/workspace';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'conversion-race-' + randomUUID();
const actor = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
let safe = false, workspaceId: string, sourceId: string, sentinelId: string, taskId: string, organisationId: string, pipelineId: string;
let completed = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const pipeline = await db.pipeline.findUnique({ where: { key: 'DEAL_PROACTIVE' }, include: { stages: { take: 1 } } });
  if (!pipeline?.stages.length) throw new Error('Disposable deal pipeline seed is incomplete.');
  pipelineId = pipeline.id;
  await db.user.create({ data: { id: actor.id, workspaceId, name: prefix, email: prefix + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  sourceId = (await db.project.create({ data: { workspaceId, name: prefix + '-source' } })).id;
  await db.projectMember.create({ data: { projectId: sourceId, userId: actor.id, role: 'LEADER' } });
  const section = await db.section.create({ data: { projectId: sourceId, name: 'To do', position: 0 } });
  taskId = (await db.task.create({ data: { workspaceId, projectId: sourceId, sectionId: section.id, title: prefix + '-task', assigneeId: actor.id, createdById: actor.id, isIdea: true } })).id;
  organisationId = (await db.organisation.create({ data: { workspaceId, name: prefix + '-buyer', createdById: actor.id } })).id;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    const ids = (await db.project.findMany({ where: { workspaceId, name: { startsWith: prefix } }, select: { id: true } })).map((p) => p.id);
    await db.notification.deleteMany({ where: { projectId: { in: ids } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { actorId: actor.id } });
    await db.project.deleteMany({ where: { id: { in: ids } } });
    await db.organisation.deleteMany({ where: { id: organisationId } });
    await db.user.delete({ where: { id: actor.id } });
    expect(await db.project.count({ where: { id: { in: ids } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/deal-conversion-race', { recursive: true });
    writeFileSync('test-results/deal-conversion-race/cleanup.json', JSON.stringify({ fixture: prefix, completed, cleanup }, null, 2));
  }
});

const transact = db.$transaction.bind(db);
function pauseBeforeTransactions(count: number) {
  let arrived = 0;
  let release!: () => void;
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

it('has one winner and no orphan deal when two clients convert the same task', async () => {
  const pause = pauseBeforeTransactions(2);
  const input = { organisationId, pipelineId, whyPursue: 'Fits our work', dueDate: '2026-11-30' };
  const pending = Promise.allSettled([convertTaskToDeal(actor, taskId, input), convertTaskToDeal(actor, taskId, input)]);
  try {
    await pause.ready();
    pause.release();
    const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const deals = await db.project.findMany({ where: { workspaceId, name: prefix + '-task', typeId: 'wst_deal' } });
    expect(deals).toHaveLength(1);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).projectId).toBe(deals[0].id);
    completed = true;
  } finally {
    pause.release();
    await pending;
  }
});
