// A child must not appear live after its parent was deleted during creation.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { createTask, deleteTask } from '@/lib/tasks';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-parent-delete-race-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const people = [leader, editor], projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
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
    await db.user.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/task-create-parent-delete-race', { recursive: true });
    writeFileSync('test-results/task-create-parent-delete-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-create-parent-delete-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [{ projectId: project.id, userId: leader.id, role: 'LEADER' }, { projectId: project.id, userId: editor.id, role: 'EDITOR' }] });
  const todo = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  await db.section.create({ data: { projectId: project.id, name: 'Done', position: 1, isDone: true } });
  const parent = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: todo.id, title: prefix, assigneeId: editor.id, createdById: leader.id } });
  return { projectId: project.id, parentId: parent.id };
}

it('serializes child creation with parent deletion and leaves no live orphan', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atCreate = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async tx => {
    const original = tx.task.create.bind(tx.task);
    vi.spyOn(tx.task, 'create').mockImplementationOnce(((args) => {
      reached(); return held.then(() => original(args)) as ReturnType<typeof tx.task.create>;
    }) as typeof tx.task.create);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const creating = Promise.allSettled([createTask(editor, f.projectId, { title: 'Late child', parentId: f.parentId })]);
  const safety = setTimeout(() => release(), 15_000);
  try {
    await Promise.race([atCreate, creating.then(() => { throw Error('Creation passed its expected gate.'); })]);
    spy.mockRestore();
    const deleting = Promise.allSettled([deleteTask(leader, f.parentId)]);
    await Promise.race([deleting, new Promise(resolve => setTimeout(resolve, 750))]);
    release();
    const [deletion] = await deleting; expect(deletion.status).toBe('fulfilled');
    const [creation] = await creating;
    if (creation.status !== 'fulfilled') throw creation.reason;
    const [parent, child] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: f.parentId } }),
      db.task.findUniqueOrThrow({ where: { id: creation.value } }),
    ]);
    expect(parent.deletedAt).not.toBeNull();
    expect(child.deletedAt?.getTime()).toBe(parent.deletedAt?.getTime());
    expect(await db.task.count({ where: { parentId: f.parentId, deletedAt: null } })).toBe(0);
    completed.push('delete-create-serialization');
  } finally { clearTimeout(safety); release(); spy.mockRestore(); await creating; }
}, 20_000);

it('rejects a child when the parent was already deleted', async () => {
  const f = await fixture(); await deleteTask(leader, f.parentId);
  await expect(createTask(editor, f.projectId, { title: 'Late child', parentId: f.parentId })).rejects.toMatchObject({ status: 404 });
  expect(await db.task.count({ where: { parentId: f.parentId } })).toBe(0);
  completed.push('deleted-parent-control');
});

it('reports a changing parent and permits a safe retry', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atLock = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = transact(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.parentId} FOR UPDATE`;
    reached(); await held;
  });
  const safety = setTimeout(() => release(), 15_000);
  try {
    await atLock;
    await expect(createTask(editor, f.projectId, { title: 'Blocked child', parentId: f.parentId })).rejects.toMatchObject({ status: 409 });
    expect(await db.task.count({ where: { parentId: f.parentId } })).toBe(0);
  } finally { clearTimeout(safety); release(); await blocker; }
  const id = await createTask(editor, f.projectId, { title: 'Safe child', parentId: f.parentId });
  expect((await db.task.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  completed.push('locked-parent-retry');
}, 20_000);
