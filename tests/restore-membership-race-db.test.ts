// Controlled reproduction of restoration racing with member removal in disposable PostgreSQL.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { removeMember } from '@/lib/projects';
import { restoreTask } from '@/lib/tasks';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'restore-membership-' + randomUUID();
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
    mkdirSync('test-results/restore-membership-race', { recursive: true });
    writeFileSync('test-results/restore-membership-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'disposable-postgres-reproduction', cleanup }, null, 2));
  }
});

it('never leaves a restored live task assigned to a removed member', async () => {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Deleted assignment', assigneeId: editor.id, createdById: leader.id, deletedAt: new Date() } });
  const transact = db.$transaction.bind(db);
  let reached!: () => void, release!: () => void;
  const atDelete = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const originalDelete = tx.projectMember.delete.bind(tx.projectMember);
    vi.spyOn(tx.projectMember, 'delete').mockImplementationOnce(((args) => {
      reached();
      return held.then(() => originalDelete(args)) as ReturnType<typeof tx.projectMember.delete>;
    }) as typeof tx.projectMember.delete);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const removing = removeMember(leader, project.id, editor.id);
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atDelete, removing.then(() => { throw Error('Removal passed the expected gate.'); })]);
    intercepted.mockRestore();
    await restoreTask(leader, task.id);
    expect(safetyExpired).toBe(false);
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
    await removing;
  }
  const [live, member] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: task.id } }),
    db.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: editor.id } } }),
  ]);
  const valid = live.deletedAt !== null || live.assigneeId === leader.id || member?.role === 'EDITOR';
  mkdirSync('test-results/restore-membership-race', { recursive: true });
  writeFileSync('test-results/restore-membership-race/reproduction.json', JSON.stringify({ removed: !member, live: live.deletedAt === null, assigneeStillDeparted: live.assigneeId === editor.id, invariantHolds: valid }, null, 2));
  expect(valid).toBe(true);
}, 20_000);
