// Controlled pre-fix permission race for task.moved Undo in disposable PostgreSQL.
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

const prefix = 'undo-move-' + randomUUID();
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
    mkdirSync('test-results/undo-move', { recursive: true });
    writeFileSync('test-results/undo-move/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-move-undo-pre-fix', cleanup }, null, 2));
  }
});

it('refuses a removed actor after Undo preflight without moving the task or claiming the action', async () => {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const from = await db.section.create({ data: { projectId: project.id, name: 'From', position: 0 } });
  const to = await db.section.create({ data: { projectId: project.id, name: 'To', position: 1 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: to.id, title: 'Moved task', assigneeId: leader.id, createdById: leader.id } });
  const action = await db.actionLog.create({ data: { actorId: editor.id, projectId: project.id, targetType: 'task', targetId: task.id, channel: 'SCREEN', action: 'task.moved', beforeState: { sectionId: from.id }, afterState: { sectionId: to.id }, createdAt: new Date(Date.now() - 2000) } });
  const snapshot = async () => ({
    task: await db.task.findUniqueOrThrow({ where: { id: task.id } }),
    actions: await db.actionLog.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }),
    notices: await db.notification.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }),
  });
  const transact = db.$transaction.bind(db);
  let reached!: () => void, release!: () => void;
  const atTransaction = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    reached(); await held; return transact(callback, options);
  }) as typeof db.$transaction);
  const pending = undoAction(editor, action.id);
  let before: Awaited<ReturnType<typeof snapshot>>;
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atTransaction, pending.then(() => { throw Error('Undo passed the expected transaction gate.'); })]);
    intercepted.mockRestore();
    await removeMember(leader, project.id, editor.id);
    before = await snapshot();
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
  }
  const result = await Promise.allSettled([pending]);
  const after = await snapshot();
  const denied = result[0].status === 'rejected' && (result[0].reason as { status?: number }).status === 404;
  const unchanged = JSON.stringify(after) === JSON.stringify(before!);
  mkdirSync('test-results/undo-move', { recursive: true });
  writeFileSync('test-results/undo-move/reproduction.json', JSON.stringify({ actorRemoved: true, denied, unchanged, sectionReverted: after.task.sectionId === from.id, actionClaimed: (after.actions.find((row) => row.id === action.id)?.undoneAt ?? null) !== null, safetyExpired }, null, 2));
  expect({ denied, unchanged, safetyExpired }).toEqual({ denied: true, unchanged: true, safetyExpired: false });
}, 20_000);
