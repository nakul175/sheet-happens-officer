// SHO-REG-PROJECTS-04: exact 30-day task Trash boundary, restore roles and scoped purge.
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { purgeTrash, restoreTask } from '@/lib/tasks';
import { UNDO_WINDOW_MS } from '@/lib/undoable';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { assertLocalFixture } from './e2e/local-fixture-guard';
import { BASE, PW } from './helpers';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = `project-trash-boundary-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: 'MEMBER' as const };
const editor = { id: `${prefix}-editor`, orgRole: 'MEMBER' as const };
const viewer = { id: `${prefix}-viewer`, orgRole: 'MEMBER' as const };
const admin = { id: `${prefix}-admin`, orgRole: 'ADMIN' as const };
const userIds: string[] = [];
const projectIds: string[] = [];
let auditBeforeIds: Set<string> | null = null;
let safe = false;
let projectId = '';
let sectionId = '';
let sentinelProjectId = '';
let sentinelSectionId = '';
let workspaceId = '';
let cleanup = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  const salt = randomBytes(16);
  const leaderPasswordHash = `scrypt$${salt.toString('base64')}$${scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  for (const actor of [leader, editor, viewer, admin]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: actor.id === leader.id ? leaderPasswordHash : 'unused', emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
    userIds.push(actor.id);
  }
  const project = await db.project.create({ data: { workspaceId, name: prefix } });
  projectId = project.id;
  projectIds.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId, userId: leader.id, role: 'LEADER' },
    { projectId, userId: editor.id, role: 'EDITOR' },
    { projectId, userId: viewer.id, role: 'VIEWER' },
  ] });
  sectionId = (await db.section.create({ data: { projectId, name: 'To do', position: 0 } })).id;
  const sentinelProject = await db.project.create({ data: { workspaceId, name: `${prefix}-unrelated` } });
  sentinelProjectId = sentinelProject.id;
  projectIds.push(sentinelProjectId);
  await db.projectMember.create({ data: { projectId: sentinelProjectId, userId: leader.id, role: 'LEADER' } });
  sentinelSectionId = (await db.section.create({ data: { projectId: sentinelProjectId, name: 'To do', position: 0 } })).id;
});

afterAll(async () => {
  if (!safe) return;
  try {
    await db.notification.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: projectIds } } });
    if (auditBeforeIds) {
      const ownedAuditIds = (await db.auditLog.findMany({ where: { event: 'TASK_PURGED' }, select: { id: true } })).map(row => row.id).filter(id => !auditBeforeIds!.has(id));
      if (ownedAuditIds.length) await db.auditLog.deleteMany({ where: { id: { in: ownedAuditIds } } });
    }
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    expect(await db.project.count({ where: { id: { in: projectIds } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: userIds } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/project-trash-boundary', { recursive: true });
    writeFileSync('test-results/project-trash-boundary/cleanup.json', JSON.stringify({ fixture: prefix, scope: 'disposable-local-postgres', cleanup, projectIds, userIds }, null, 2));
  }
});

it('preserves exact-boundary and unrelated Trash, purges only expired owned tasks, and enforces restore roles', async () => {
  const now = new Date();
  const cutoff = now.getTime() - UNDO_WINDOW_MS;
  const create = (name: string, deletedAt: number, inProject = projectId, inSection = sectionId) => db.task.create({ data: {
    workspaceId, projectId: inProject, sectionId: inSection,
    title: `${prefix}-${name}`, assigneeId: leader.id, createdById: leader.id,
    deletedAt: new Date(deletedAt), deletedById: leader.id,
  } });
  const recent = await create('recent', cutoff + 1);
  const exact = await create('exact', cutoff);
  const exactForLeaderService = await create('exact-leader-service', cutoff);
  const expired = await create('expired', cutoff - 1);
  const sentinel = await create('unrelated-sentinel', cutoff - 86_400_000, sentinelProjectId, sentinelSectionId);
  const sentinelBefore = await db.task.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, title: true, deletedAt: true, projectId: true } });
  auditBeforeIds = new Set((await db.auditLog.findMany({ where: { event: 'TASK_PURGED' }, select: { id: true } })).map(row => row.id));

  await expect(restoreTask(editor, exact.id)).rejects.toMatchObject({ status: 403 });
  await expect(restoreTask(viewer, exact.id)).rejects.toMatchObject({ status: 403 });
  await restoreTask(admin, recent.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: recent.id } })).deletedAt).toBeNull();

  expect(await purgeTrash(now, { projectId })).toBe(1);
  expect(await db.task.findUnique({ where: { id: expired.id } })).toBeNull();
  expect((await db.task.findUniqueOrThrow({ where: { id: exact.id } })).deletedAt?.getTime()).toBe(cutoff);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ baseURL: BASE });
    const signedIn = await context.request.post('/api/auth/signin', { data: { email: `${leader.id}@example.invalid`, password: PW } });
    expect(signedIn.status()).toBe(200);
    const page = await context.newPage();
    await page.goto(`/projects/${projectId}/trash`);
    const exactRow = page.getByRole('row', { name: new RegExp(`${prefix}-exact(?:\\s|$)`) });
    await exactRow.waitFor({ state: 'visible' });
    expect(await page.getByRole('row', { name: new RegExp(`${prefix}-expired`) }).count()).toBe(0);
    expect(await exactRow.getByText('0 days left').count()).toBe(1);
    mkdirSync('test-results/project-trash-boundary', { recursive: true });
    await page.screenshot({ path: 'test-results/project-trash-boundary/exact-boundary-trash.png', fullPage: true });
    await exactRow.getByRole('button', { name: 'Restore' }).click();
    await exactRow.waitFor({ state: 'detached' });
    expect((await context.request.get(`/api/tasks/${exact.id}`)).status()).toBe(200);
    await context.close();
  } finally {
    await browser.close();
  }
  expect((await db.task.findUniqueOrThrow({ where: { id: exact.id } })).deletedAt).toBeNull();
  await restoreTask(leader, exactForLeaderService.id);
  expect((await db.task.findUniqueOrThrow({ where: { id: exactForLeaderService.id } })).deletedAt).toBeNull();
  expect(await db.task.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, title: true, deletedAt: true, projectId: true } })).toEqual(sentinelBefore);
  expect(await db.project.findUnique({ where: { id: projectId }, select: { id: true } })).toEqual({ id: projectId });
  expect(await db.project.findUnique({ where: { id: sentinelProjectId }, select: { id: true } })).toEqual({ id: sentinelProjectId });
  const newAudit = (await db.auditLog.findMany({ where: { event: 'TASK_PURGED' }, select: { id: true } })).map(row => row.id).filter(id => !auditBeforeIds!.has(id));
  expect(newAudit).toHaveLength(1);

  mkdirSync('test-results/project-trash-boundary', { recursive: true });
  writeFileSync('test-results/project-trash-boundary/verification.json', JSON.stringify({ fixture: prefix, cutoff: new Date(cutoff).toISOString(), denied: ['EDITOR', 'VIEWER'], restored: ['ADMIN recent', 'LEADER exact through signed-in Chromium', 'LEADER exact through service'], purged: 1, scopedProjectId: projectId, unrelatedProjectId: sentinelProjectId, exactBoundaryBrowserRestored: true, sentinelPreserved: true, projectPreserved: true }, null, 2));
}, 90_000);
