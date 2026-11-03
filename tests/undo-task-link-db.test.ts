// Real PostgreSQL interleavings for task-link add/remove Undo.
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

const prefix = 'undo-task-link-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], organisations: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
    users.push(actor.id);
  }
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-task-link', { recursive: true });
    writeFileSync('test-results/undo-task-link/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-link-undo-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture(kind: 'task.link_added' | 'task.link_removed') {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + kind } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: kind, assigneeId: leader.id, createdById: leader.id } });
  const organisation = await db.organisation.create({ data: { workspaceId, name: prefix + '-organisation', createdById: leader.id } }); organisations.push(organisation.id);
  const linkId = prefix + '-' + randomUUID();
  if (kind === 'task.link_added') await db.taskLink.create({ data: { id: linkId, taskId: task.id, organisationId: organisation.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind,
    beforeState: kind === 'task.link_removed' ? { linkId, organisationId: organisation.id } : {},
    afterState: kind === 'task.link_added' ? { linkId, organisationId: organisation.id } : {}, createdAt: new Date(Date.now() - 2000) } });
  return { project, task, organisation, linkId, action };
}
async function snapshot(projectId: string, taskId: string) {
  const [links, actions, notices] = await Promise.all([
    db.taskLink.findMany({ where: { taskId }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { links, actions, notices };
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

for (const kind of ['task.link_added', 'task.link_removed'] as const) {
  it(`${kind} Undo refuses an actor removed after preflight without changing link/action/activity`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      await removeMember(leader, f.project.id, editor.id);
      const before = await snapshot(f.project.id, f.task.id);
      pause.release();
      const [result] = await pending;
      const after = await snapshot(f.project.id, f.task.id);
      const denied = result.status === 'rejected' && (result.reason as { status?: number }).status === 404;
      const unchanged = JSON.stringify(after) === JSON.stringify(before);
      mkdirSync('test-results/undo-task-link', { recursive: true });
      writeFileSync(`test-results/undo-task-link/verification-${kind}.json`, JSON.stringify({ kind, actorRemoved: true, denied, unchanged, actionClaimed: (after.actions.find((x) => x.id === f.action.id)?.undoneAt ?? null) !== null }, null, 2));
      expect({ denied, unchanged }).toEqual({ denied: true, unchanged: true });
      completed.push(kind + ':removed-after-preflight');
    } finally { pause.release(); await pending; }
  }, 20_000);
}
