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
const projects: string[] = [], organisations: string[] = [], contacts: string[] = [], users: string[] = [], completed: string[] = [];
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
    await db.contact.deleteMany({ where: { id: { in: contacts } } });
    await db.organisation.deleteMany({ where: { id: { in: organisations } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
    expect(await db.contact.count({ where: { id: { in: contacts } } })).toBe(0);
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

  it(`${kind} Undo rechecks link state after preflight`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(1);
    const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
    try {
      await pause.ready();
      if (kind === 'task.link_added') await db.taskLink.delete({ where: { id: f.linkId } });
      else await db.taskLink.create({ data: { taskId: f.task.id, organisationId: f.organisation.id } });
      const before = await snapshot(f.project.id, f.task.id); pause.release();
      expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
      expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneAt).toBeNull();
      completed.push(kind + ':state-after-preflight');
    } finally { pause.release(); await pending; }
  });

  it(`${kind} duplicate Undo has one winner, one claim and one activity row`, async () => {
    const f = await fixture(kind), pause = pauseBeforeTransactions(2);
    const results = Promise.allSettled([undoAction(editor, f.action.id), undoAction(editor, f.action.id)]);
    try {
      await pause.ready(); pause.release(); const settled = await results;
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
      expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: f.action.id } })).undoneById).toBe(editor.id);
      expect(await db.taskLink.count({ where: { taskId: f.task.id } })).toBe(kind === 'task.link_removed' ? 1 : 0);
      completed.push(kind + ':duplicate-one-winner');
    } finally { pause.release(); await results; }
  });

  it(`${kind} activity failure rolls back inverse and claim; retry succeeds`, async () => {
    const f = await fixture(kind), before = await snapshot(f.project.id, f.task.id);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>) => transact(async (tx) => {
      const create = vi.spyOn(tx.actionLog, 'create').mockRejectedValueOnce(Error('TASK_LINK_UNDO_ACTIVITY_FAILURE'));
      try { return await callback(tx); } finally { create.mockRestore(); }
    })) as typeof db.$transaction);
    await expect(undoAction(editor, f.action.id)).rejects.toThrow('TASK_LINK_UNDO_ACTIVITY_FAILURE');
    vi.restoreAllMocks();
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    await undoAction(editor, f.action.id);
    expect(await db.taskLink.count({ where: { taskId: f.task.id } })).toBe(kind === 'task.link_removed' ? 1 : 0);
    expect(await db.actionLog.count({ where: { projectId: f.project.id, action: 'undo' } })).toBe(1);
    completed.push(kind + ':activity-rollback-retry');
  });
}

it('link restoration rejects a removed contact target', async () => {
  const f = await fixture('task.link_removed');
  const contact = await db.contact.create({ data: { workspaceId, organisationId: f.organisation.id, name: prefix + '-contact', createdById: leader.id, removedAt: new Date() } }); contacts.push(contact.id);
  await db.actionLog.update({ where: { id: f.action.id }, data: { beforeState: { linkId: f.linkId, contactId: contact.id } } });
  const before = await snapshot(f.project.id, f.task.id);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
  completed.push('removed-contact-target-rejected');
});

it('link restoration rejects an organisation target deleted since the action', async () => {
  const f = await fixture('task.link_removed');
  await db.organisation.delete({ where: { id: f.organisation.id } });
  const before = await snapshot(f.project.id, f.task.id);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
  completed.push('missing-organisation-target-rejected');
});

it('a task-link row lock makes inverse deletion retryable without a partial claim', async () => {
  const f = await fixture('task.link_added'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TaskLink" WHERE "id" = ${f.linkId} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('task-link-row-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect(await db.taskLink.count({ where: { taskId: f.task.id } })).toBe(0);
});

it('a contact-row lock makes link restoration retryable without a partial claim', async () => {
  const f = await fixture('task.link_removed');
  const contact = await db.contact.create({ data: { workspaceId, organisationId: f.organisation.id, name: prefix + '-live-contact', createdById: leader.id } }); contacts.push(contact.id);
  await db.actionLog.update({ where: { id: f.action.id }, data: { beforeState: { linkId: f.linkId, contactId: contact.id } } });
  let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${contact.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('contact-row-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect(await db.taskLink.count({ where: { taskId: f.task.id, contactId: contact.id } })).toBe(1);
});

it('an organisation-row lock makes link restoration retryable without a partial claim', async () => {
  const f = await fixture('task.link_removed'); let release!: () => void, locked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const owner = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${f.organisation.id} FOR UPDATE`;
    locked = true; await held;
  }, { timeout: 15_000 });
  const ownerResult = Promise.allSettled([owner]);
  try {
    await vi.waitFor(() => expect(locked).toBe(true), { timeout: 5000 });
    const before = await snapshot(f.project.id, f.task.id);
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('organisation-row-lock-conflict');
  } finally { release(); expect(await ownerResult).toEqual([{ status: 'fulfilled', value: undefined }]); }
  await undoAction(editor, f.action.id);
  expect(await db.taskLink.count({ where: { taskId: f.task.id, organisationId: f.organisation.id } })).toBe(1);
});

it('Undo cannot remove a link that belongs to another task', async () => {
  const first = await fixture('task.link_added'), second = await fixture('task.link_added');
  await db.actionLog.update({ where: { id: first.action.id }, data: { afterState: { linkId: second.linkId, organisationId: second.organisation.id } } });
  const before = await snapshot(first.project.id, first.task.id);
  await expect(undoAction(editor, first.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(first.project.id, first.task.id)).toEqual(before);
  expect(await db.taskLink.count({ where: { id: second.linkId } })).toBe(1);
  completed.push('foreign-task-link-rejected');
});

it('Undo cannot delete a link after its logged target no longer matches', async () => {
  const f = await fixture('task.link_added');
  const other = await db.organisation.create({ data: { workspaceId, name: prefix + '-other-target', createdById: leader.id } }); organisations.push(other.id);
  await db.actionLog.update({ where: { id: f.action.id }, data: { afterState: { linkId: f.linkId, organisationId: other.id } } });
  const before = await snapshot(f.project.id, f.task.id);
  await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
  expect(await db.taskLink.count({ where: { id: f.linkId } })).toBe(1);
  completed.push('changed-link-target-rejected');
});

it('CRM-hidden mode denies task-link Undo without changing the link or claim', async () => {
  const f = await fixture('task.link_added'), before = await snapshot(f.project.id, f.task.id);
  const previous = process.env.CRM_VISIBLE;
  try {
    process.env.CRM_VISIBLE = 'off';
    await expect(undoAction(editor, f.action.id)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('crm-hidden-undo-denied');
  } finally {
    if (previous === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = previous;
  }
});

it('Undo rechecks project archive after preflight before deleting a task link', async () => {
  const f = await fixture('task.link_added'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.project.update({ where: { id: f.project.id }, data: { archivedAt: new Date() } });
    const before = await snapshot(f.project.id, f.task.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })]);
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('archive-after-preflight');
  } finally { pause.release(); await pending; }
});

it('Undo rechecks Viewer downgrade after preflight before restoring a task link', async () => {
  const f = await fixture('task.link_removed'), pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([undoAction(editor, f.action.id)]);
  try {
    await pause.ready();
    await db.projectMember.update({ where: { projectId_userId: { projectId: f.project.id, userId: editor.id } }, data: { role: 'VIEWER' } });
    const before = await snapshot(f.project.id, f.task.id); pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })]);
    expect(await snapshot(f.project.id, f.task.id)).toEqual(before);
    completed.push('viewer-after-preflight');
  } finally { pause.release(); await pending; }
});
