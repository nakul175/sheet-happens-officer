// Controlled collaborator writes against membership and account changes on disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { addCollaborator } from '@/lib/tasks';
import { deactivate } from '@/lib/team';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'task-collaborator-race-' + randomUUID();
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const recipient = { id: prefix + '-recipient', orgRole: 'MEMBER' as const };
const people = [admin, leader, editor, recipient];
const projects: string[] = [], completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, sentinelId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of people) await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id;
  projects.push(sentinelId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!safe) return;
  await db.user.update({ where: { id: recipient.id }, data: { deactivatedAt: null } });
  await db.projectMember.updateMany({ where: { projectId: { in: projects }, userId: editor.id }, data: { role: 'EDITOR' } });
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    await db.notification.deleteMany({ where: { projectId: { in: projects } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/task-collaborator-race', { recursive: true });
    writeFileSync('test-results/task-collaborator-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-collaborator-disposable-postgres', completed, cleanup }, null, 2));
  }
});

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
    { projectId: project.id, userId: recipient.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: prefix, assigneeId: leader.id, createdById: leader.id } });
  return { projectId: project.id, taskId: task.id };
}
function pauseBeforeTransactions() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { async ready() { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it('rejects an Editor downgraded after collaborator preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([addCollaborator(editor, f.taskId, recipient.id)]);
  try {
    await pause.ready();
    await db.projectMember.update({ where: { projectId_userId: { projectId: f.projectId, userId: editor.id } }, data: { role: 'VIEWER' } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await db.taskCollaborator.count({ where: { taskId: f.taskId } })).toBe(0);
    completed.push('downgraded-editor');
  } finally { pause.release(); await pending; }
});

it('rejects a project archived after collaborator preflight', async () => {
  const f = await fixture(), pause = pauseBeforeTransactions();
  const pending = Promise.allSettled([addCollaborator(editor, f.taskId, recipient.id)]);
  try {
    await pause.ready(); await db.project.update({ where: { id: f.projectId }, data: { archivedAt: new Date() } }); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.taskCollaborator.count({ where: { taskId: f.taskId } })).toBe(0);
    completed.push('archived-project');
  } finally { pause.release(); await pending; }
});

it('deactivation cannot miss a collaborator inserted after eligibility check', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atInsert = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const original = tx.taskCollaborator.create.bind(tx.taskCollaborator);
    vi.spyOn(tx.taskCollaborator, 'create').mockImplementationOnce(((args) => {
      reached(); return held.then(() => original(args)) as ReturnType<typeof tx.taskCollaborator.create>;
    }) as typeof tx.taskCollaborator.create);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const adding = Promise.allSettled([addCollaborator(leader, f.taskId, recipient.id)]);
  const safety = setTimeout(() => release(), 10_000);
  try {
    await Promise.race([atInsert, adding.then(() => { throw Error('Collaborator insertion passed its expected gate.'); })]);
    spy.mockRestore();
    await expect(deactivate(admin, recipient.id, 'leaders')).rejects.toMatchObject({ status: 409 });
  } finally { clearTimeout(safety); release(); spy.mockRestore(); await adding; }
  expect((await adding)[0].status).toBe('fulfilled');
  await deactivate(admin, recipient.id, 'leaders');
  expect(await db.taskCollaborator.count({ where: { taskId: f.taskId, userId: recipient.id } })).toBe(0);
  completed.push('deactivation-collaborator-serialization');
}, 20_000);

it('adds an eligible collaborator once with a matching action', async () => {
  const f = await fixture();
  await addCollaborator(editor, f.taskId, recipient.id);
  expect(await db.taskCollaborator.count({ where: { taskId: f.taskId, userId: recipient.id } })).toBe(1);
  expect(await db.actionLog.count({ where: { projectId: f.projectId, targetId: f.taskId, action: 'task.collaborator_added' } })).toBe(1);
  completed.push('eligible-control');
});
