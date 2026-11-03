// Controlled pre-fix permission races for task.completed and task.reopened Undo.
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

const prefix = 'undo-completion-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const projects: string[] = [], users: string[] = [];
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
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: users } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/undo-completion', { recursive: true });
    writeFileSync('test-results/undo-completion/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'completion-undo-pre-fix', cleanup }, null, 2));
  }
});

async function fixture(kind: 'task.completed' | 'task.reopened') {
  const project = await db.project.create({ data: { workspaceId, name: prefix + '-' + kind } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const todo = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const done = await db.section.create({ data: { projectId: project.id, name: 'Done', position: 1, isDone: true } });
  const completedAt = new Date(Date.now() - 5000);
  const completed = kind === 'task.completed';
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: completed ? done.id : todo.id, title: kind, assigneeId: leader.id, createdById: leader.id, completedAt: completed ? completedAt : null } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: kind,
    beforeState: completed ? { completedAt: null, sectionId: todo.id, previousSectionId: null } : { completedAt, sectionId: done.id },
    afterState: completed ? { completedAt, sectionId: done.id } : { completedAt: null, sectionId: todo.id },
    createdAt: new Date(Date.now() - 2000) } });
  return { project, task, action, todo, done };
}
async function snapshot(projectId: string) {
  const [tasks, actions, notices] = await Promise.all([
    db.task.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  return { tasks, actions, notices };
}

for (const kind of ['task.completed', 'task.reopened'] as const) {
  it(`${kind} Undo refuses an actor removed after preflight without changing task/action/activity`, async () => {
    const f = await fixture(kind), transact = db.$transaction.bind(db);
    let reached!: () => void, release!: () => void;
    const atTransaction = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
      reached(); await held; return transact(callback, options);
    }) as typeof db.$transaction);
    const pending = undoAction(editor, f.action.id);
    let before: Awaited<ReturnType<typeof snapshot>>;
    let safetyExpired = false;
    const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
    try {
      await Promise.race([atTransaction, pending.then(() => { throw Error('Undo passed the expected transaction gate.'); })]);
      intercepted.mockRestore();
      await removeMember(leader, f.project.id, editor.id);
      before = await snapshot(f.project.id);
    } finally {
      clearTimeout(safety); release(); intercepted.mockRestore();
    }
    const result = await Promise.allSettled([pending]);
    const after = await snapshot(f.project.id);
    const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
    const unchanged = JSON.stringify(after) === JSON.stringify(before!);
    mkdirSync('test-results/undo-completion', { recursive: true });
    writeFileSync(`test-results/undo-completion/reproduction-${kind}.json`, JSON.stringify({ kind, actorRemoved: true, denied, unchanged, actionClaimed: (after.actions.find((x) => x.id === f.action.id)?.undoneAt ?? null) !== null, taskCompleted: after.tasks[0].completedAt !== null, safetyExpired }, null, 2));
    expect({ denied, unchanged, safetyExpired }).toEqual({ denied: true, unchanged: true, safetyExpired: false });
  }, 20_000);
}
