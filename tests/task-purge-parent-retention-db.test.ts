// Cascading physical deletion must not shorten a child's own Trash period.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { purgeTrash } from '@/lib/tasks';
import { UNDO_WINDOW_MS } from '@/lib/undoable';
import { assertLocalFixture } from './e2e/local-fixture-guard';

const prefix = 'task-purge-parent-' + randomUUID();
const userId = prefix + '-user', projects: string[] = [], completed: string[] = [];
const now = new Date('2026-11-05T00:00:00.000Z');
const cutoff = new Date(now.getTime() - UNDO_WINDOW_MS);
let workspaceId: string, sentinelId: string, oldAuditIds: Set<string>, safe = false;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  oldAuditIds = new Set((await db.auditLog.findMany({ where: { event: 'TASK_PURGED' }, select: { id: true } })).map(row => row.id));
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.create({ data: { id: userId, workspaceId, name: prefix, email: prefix + '@example.invalid', passwordHash: 'unused', emailVerifiedAt: new Date() } });
  sentinelId = (await db.project.create({ data: { workspaceId, name: prefix + '-sentinel' } })).id; projects.push(sentinelId);
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect((await db.project.findUniqueOrThrow({ where: { id: sentinelId } })).name).toBe(prefix + '-sentinel');
    const later = await db.auditLog.findMany({ where: { event: 'TASK_PURGED' }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { id: { in: later.filter(row => !oldAuditIds.has(row.id)).map(row => row.id) } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.user.delete({ where: { id: userId } });
    expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0); cleanup = true;
  } finally {
    mkdirSync('test-results/task-purge-parent-retention', { recursive: true });
    writeFileSync('test-results/task-purge-parent-retention/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'task-purge-disposable-postgres', completed, cleanup }, null, 2));
  }
});
async function fixture(childDeletedAt: Date | null) {
  const project = await db.project.create({ data: { workspaceId, name: prefix } }); projects.push(project.id);
  await db.projectMember.create({ data: { projectId: project.id, userId, role: 'LEADER' } });
  const section = await db.section.create({ data: { projectId: project.id, name: 'To do', position: 0 } });
  const parent = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, title: prefix, assigneeId: userId, createdById: userId, deletedAt: new Date(cutoff.getTime() - 86_400_000) } });
  const child = await db.task.create({ data: { workspaceId, projectId: project.id, sectionId: section.id, parentId: parent.id, title: prefix + '-child', assigneeId: userId, createdById: userId, deletedAt: childDeletedAt } });
  return { parentId: parent.id, childId: child.id };
}

it('keeps an expired parent while its independently deleted child is still within 30 days', async () => {
  const f = await fixture(new Date(now.getTime() - 86_400_000));
  expect(await purgeTrash(now, { id: f.parentId })).toBe(0);
  expect(await db.task.findUnique({ where: { id: f.parentId } })).not.toBeNull();
  expect(await db.task.findUnique({ where: { id: f.childId } })).not.toBeNull();
  completed.push('recent-independent-child');
});

it('keeps the parent while a child is at the exact 30-day boundary', async () => {
  const f = await fixture(cutoff);
  expect(await purgeTrash(now, { id: f.parentId })).toBe(0);
  expect(await db.task.findUnique({ where: { id: f.childId } })).not.toBeNull();
  completed.push('exact-boundary-child');
});

it('purges an expired parent with only expired children', async () => {
  const f = await fixture(new Date(cutoff.getTime() - 1000));
  expect(await purgeTrash(now, { id: f.parentId })).toBe(1);
  expect(await db.task.findUnique({ where: { id: f.parentId } })).toBeNull();
  expect(await db.task.findUnique({ where: { id: f.childId } })).toBeNull();
  completed.push('expired-control');
});
