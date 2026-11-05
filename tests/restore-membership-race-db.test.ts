// Controlled restoration/member-departure interleavings in disposable PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { changeMemberRole, removeMember } from '@/lib/projects';
import { restoreTask } from '@/lib/tasks';
import { undoAction } from '@/lib/undo';
import type { Tx } from '@/lib/access';
import { assertLocalFixture } from './e2e/local-fixture-guard';
vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = 'restore-membership-' + randomUUID();
const leader = { id: prefix + '-leader', orgRole: 'MEMBER' as const };
const editor = { id: prefix + '-editor', orgRole: 'MEMBER' as const };
const admin = { id: prefix + '-admin', orgRole: 'ADMIN' as const };
const projects: string[] = [], users: string[] = [], completed: string[] = [];
let safe = false, workspaceId: string, sentinelId: string;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [leader, editor, admin]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: actor.id + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
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
    mkdirSync('test-results/restore-membership-race', { recursive: true });
    writeFileSync('test-results/restore-membership-race/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'restore-membership-serialization', completed, cleanup }, null, 2));
  }
});

async function fixture(withChild = false) {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: 'LEADER' },
    { projectId: project.id, userId: editor.id, role: 'EDITOR' },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const deletedAt = new Date();
  const task = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: 'Deleted assignment', assigneeId: withChild ? leader.id : editor.id, createdById: leader.id, deletedAt } });
  const child = withChild ? await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, parentId: task.id, title: 'Deleted subtask', assigneeId: editor.id, createdById: leader.id, deletedAt } }) : null;
  return { projectId: project.id, taskId: task.id, childId: child?.id };
}

it('never leaves a restored live task assigned to a removed member', async () => {
  const { projectId, taskId } = await fixture();
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
  const removing = removeMember(leader, projectId, editor.id);
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atDelete, removing.then(() => { throw Error('Removal passed the expected gate.'); })]);
    intercepted.mockRestore();
    await expect(restoreTask(leader, taskId)).rejects.toMatchObject({ status: 409, message: 'Project membership is changing. Reload and try again.' });
    expect(safetyExpired).toBe(false);
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
    await removing;
  }
  await restoreTask(leader, taskId);
  const [live, member] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: editor.id } } }),
  ]);
  const valid = live.deletedAt === null && live.assigneeId === leader.id && member === null;
  mkdirSync('test-results/restore-membership-race', { recursive: true });
  writeFileSync('test-results/restore-membership-race/verification.json', JSON.stringify({ removalWon: !member, restoredLive: live.deletedAt === null, handedToLeader: live.assigneeId === leader.id, invariantHolds: valid }, null, 2));
  expect(valid).toBe(true);
  completed.push('removal-first-direct-retry');
}, 20_000);

it('a Viewer downgrade blocks parent/cohort restoration until the subtask falls back to Leader', async () => {
  const { projectId, taskId, childId } = await fixture(true);
  const transact = db.$transaction.bind(db);
  let reached!: () => void, release!: () => void;
  const atUpdate = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const originalUpdate = tx.projectMember.update.bind(tx.projectMember);
    vi.spyOn(tx.projectMember, 'update').mockImplementationOnce(((args) => {
      reached();
      return held.then(() => originalUpdate(args)) as ReturnType<typeof tx.projectMember.update>;
    }) as typeof tx.projectMember.update);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const downgrading = changeMemberRole(leader, projectId, editor.id, 'VIEWER');
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atUpdate, downgrading.then(() => { throw Error('Downgrade passed the expected gate.'); })]);
    intercepted.mockRestore();
    await expect(restoreTask(leader, taskId)).rejects.toMatchObject({ status: 409, message: 'Project membership is changing. Reload and try again.' });
    expect(safetyExpired).toBe(false);
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
    await downgrading;
  }
  await restoreTask(leader, taskId);
  const [parent, child, member] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.task.findUniqueOrThrow({ where: { id: childId! } }),
    db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: editor.id } } }),
  ]);
  expect({ parentLive: parent.deletedAt === null, childLive: child.deletedAt === null, childLeader: child.assigneeId === leader.id, role: member.role }).toEqual({ parentLive: true, childLive: true, childLeader: true, role: 'VIEWER' });
  completed.push('downgrade-first-parent-cohort');
}, 20_000);

it('when restoration holds the member first, removal sees the newly live task and hands it over', async () => {
  const { projectId, taskId } = await fixture();
  const transact = db.$transaction.bind(db);
  let reached!: () => void, release!: () => void, removeEntered!: () => void;
  const atActivity = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const atRemoval = new Promise<void>((resolve) => { removeEntered = resolve; });
  const restoreSpy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async (tx) => {
    const originalCreate = tx.actionLog.create.bind(tx.actionLog);
    vi.spyOn(tx.actionLog, 'create').mockImplementationOnce(((args) => {
      reached();
      return held.then(() => originalCreate(args)) as ReturnType<typeof tx.actionLog.create>;
    }) as typeof tx.actionLog.create);
    return callback(tx);
  }, options)) as typeof db.$transaction);
  const restoring = restoreTask(leader, taskId);
  let removal: Promise<void> | undefined;
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atActivity, restoring.then(() => { throw Error('Restore passed the expected gate.'); })]);
    restoreSpy.mockRestore();
    const removeSpy = vi.spyOn(db, '$transaction').mockImplementationOnce(((callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
      removeEntered();
      return transact(callback, options);
    }) as typeof db.$transaction);
    removal = removeMember(admin, projectId, editor.id, leader.id);
    await Promise.race([atRemoval, removal.then(() => { throw Error('Removal passed the expected transaction gate.'); })]);
    removeSpy.mockRestore();
    expect(safetyExpired).toBe(false);
  } finally {
    clearTimeout(safety);
    release();
    restoreSpy.mockRestore();
    await restoring;
    if (removal) await removal;
  }
  const [live, member, handovers, notices] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: editor.id } } }),
    db.actionLog.findMany({ where: { projectId, action: 'tasks.reassigned' } }),
    db.notification.findMany({ where: { projectId, type: 'TASKS_HANDED_OVER' } }),
  ]);
  expect({ live: live.deletedAt === null, assignee: live.assigneeId, member, handovers: handovers.length, notices: notices.length }).toMatchObject({ live: true, assignee: leader.id, member: null, handovers: 1, notices: 1 });
  completed.push('restore-first-handover');
}, 20_000);

it('Undo restore returns a retryable conflict during removal and claims only after safe retry', async () => {
  const { projectId, taskId } = await fixture();
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const action = await db.actionLog.create({ data: { actorId: leader.id, projectId, targetType: 'task', targetId: taskId, channel: 'SCREEN', action: 'task.deleted', beforeState: { deletedAt: null }, afterState: { deletedAt: task.deletedAt!.toISOString() }, createdAt: new Date(Date.now() - 2000) } });
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
  const removing = removeMember(leader, projectId, editor.id);
  let safetyExpired = false;
  const safety = setTimeout(() => { safetyExpired = true; release(); }, 10_000);
  try {
    await Promise.race([atDelete, removing.then(() => { throw Error('Removal passed the expected gate.'); })]);
    intercepted.mockRestore();
    await expect(undoAction(leader, action.id)).rejects.toMatchObject({ status: 409, message: 'Project membership is changing. Reload and try again.' });
    expect((await db.actionLog.findUniqueOrThrow({ where: { id: action.id } })).undoneAt).toBeNull();
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt).not.toBeNull();
    expect(safetyExpired).toBe(false);
  } finally {
    clearTimeout(safety);
    release();
    intercepted.mockRestore();
    await removing;
  }
  await undoAction(leader, action.id);
  const [live, claimed, undoRows] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.actionLog.findUniqueOrThrow({ where: { id: action.id } }),
    db.actionLog.findMany({ where: { projectId, action: 'undo' } }),
  ]);
  expect({ live: live.deletedAt === null, assignee: live.assigneeId, claimant: claimed.undoneById, undoRows: undoRows.length }).toEqual({ live: true, assignee: leader.id, claimant: leader.id, undoRows: 1 });
  completed.push('undo-conflict-retry');
}, 20_000);
