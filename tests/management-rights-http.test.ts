// Direct management requests against disposable local PostgreSQL and the real app.
// Sessions are synthetic fixtures; sign-in behavior is tested by the auth suites.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { BASE, Client, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

const prefix = 'zzmanage' + randomUUID().replaceAll('-', '');
const roles = ['creator', 'leader', 'editor', 'viewer', 'outsider', 'admin', 'target', 'spare'] as const;
type Role = typeof roles[number];
const people = {} as Record<Role, Account>;
const userIds: string[] = [], projects: string[] = [];
const probes: { scenario: string; operation: string; status: number; state?: string }[] = [];
const completed: string[] = [];
let safe = false, sentinelId: string, sentinel: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL, BASE); safe = true;
  const workspaceId = (await getOrCreateWorkspace()).id;
  for (const role of roles) {
    const id = prefix + role, token = randomBytes(32).toString('hex');
    const user = await db.user.create({ data: { id, workspaceId, name: role, email: id + '@aplyd.com', passwordHash: 'unused-synthetic-fixture', emailVerifiedAt: new Date(), orgRole: role === 'admin' ? 'ADMIN' : 'MEMBER' } });
    userIds.push(id);
    await db.session.create({ data: { userId: id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
    const c = new Client(); c.cookie = 'sho_session=' + token;
    people[role] = { id, c, name: user.name, email: user.email };
    const response = await c.get('/api/auth/me');
    expect(response.status).toBe(200); expect(response.json.user.id).toBe(id);
    expect(response.json.user.orgRole).toBe(role === 'admin' ? 'ADMIN' : 'MEMBER');
  }
  sentinelId = (await fixture()).id; sentinel = await snapshot(sentinelId);
}, 30_000);

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try { if (sentinel) expect(await snapshot(sentinelId)).toEqual(sentinel); }
  finally {
    try {
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: userIds } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync('test-results/management-rights', { recursive: true });
      writeFileSync('test-results/management-rights/matrix.json', JSON.stringify({ fixture: prefix, scope: 'private-local-http-project-management', cleanup, completed, probes }, null, 2));
    }
  }
});

async function fixture() {
  const name = prefix + '-' + projects.length;
  const created = await people.creator.c.post('/api/projects', { name, leaderId: people.leader.id });
  expect(created.status).toBe(201);
  const id = created.json.project.id as string; projects.push(id);
  for (const role of ['editor', 'viewer', 'target'] as const) {
    expect((await people.leader.c.post(`/api/projects/${id}/members`, { userId: people[role].id, role: role === 'viewer' ? 'VIEWER' : 'EDITOR' })).status).toBe(201);
  }
  const view = (await people.leader.c.get(`/api/projects/${id}`)).json.project;
  const [first, second] = view.sections as { id: string }[];
  const workspaceId = (await db.user.findUniqueOrThrow({ where: { id: people.leader.id }, select: { workspaceId: true } })).workspaceId;
  const task = await db.task.create({ data: { workspaceId, projectId: id, sectionId: first.id, title: 'Management boundary control', assigneeId: people.leader.id, createdById: people.leader.id } });
  return { id, name, first: first.id, second: second.id, task };
}

async function snapshot(id: string) {
  // Stable ordered snapshots include versions and full stored activity/notices.
  // Session lastSeenAt is intentionally outside the project-mutation boundary.
  const [project, members, sections, tasks, actions, notifications, audit] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id } }),
    db.projectMember.findMany({ where: { projectId: id }, orderBy: { userId: 'asc' } }),
    db.section.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
    db.task.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
    db.actionLog.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
    db.notification.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
    db.auditLog.findMany({ where: { targetId: id }, orderBy: { id: 'asc' } }),
  ]);
  return { project, members, sections, tasks, actions, notifications, audit };
}

for (const scenario of ['editor', 'viewer', 'outsider', 'removed-creator'] as const) {
  it(`${scenario}: management requests fail without changing records, versions, activity or notifications`, async () => {
    const f = await fixture(), path = `/api/projects/${f.id}`;
    const who = scenario === 'removed-creator' ? people.creator : people[scenario];
    if (scenario === 'removed-creator') expect((await people.leader.c.del(`${path}/members/${who.id}`)).status).toBe(204);
    const expected = scenario === 'outsider' || scenario === 'removed-creator' ? 404 : 403;
    expect((await who.c.get(path)).status).toBe(expected === 404 ? 404 : 200);
    if (scenario === 'editor') {
      // Positive edit control distinguishes an Editor from a read-only seat.
      expect((await who.c.patch(`/api/tasks/${f.task.id}`, { title: 'Allowed ordinary edit', expectedUpdatedAt: f.task.updatedAt.toISOString() })).status).toBe(200);
      expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).title).toBe('Allowed ordinary edit');
    }
    const before = await snapshot(f.id);
    const calls: [string, string, unknown?][] = [
      ['PATCH', path, { name: 'Denied rename' }], ['POST', path + '/archive', {}],
      ['POST', path + '/unarchive', {}], ['POST', path + '/delete', { confirmationName: f.name }], ['POST', path + '/restore', {}],
      ['POST', path + '/members', { userId: people.spare.id, role: 'EDITOR' }],
      ['PATCH', path + '/members/' + people.target.id, { role: 'VIEWER' }], ['DELETE', path + '/members/' + people.target.id],
      ['POST', path + '/leader', { newLeaderId: people.target.id }], ['POST', path + '/sections', { name: 'Denied section' }],
      ['PATCH', path + '/sections/' + f.first, { name: 'Denied section rename' }], ['DELETE', path + '/sections/' + f.first + '?moveTo=' + f.second],
    ];
    if (scenario === 'viewer') {
      const taskPath = `/api/tasks/${f.task.id}`;
      expect((await who.c.get(taskPath)).status).toBe(200);
      expect((await who.c.get(path + '/tasks')).status).toBe(200);
      calls.push(
        ['POST', path + '/tasks', { title: 'Denied task', dueDate: '2026-11-30' }],
        ['PATCH', taskPath, { title: 'Denied task edit', expectedUpdatedAt: f.task.updatedAt.toISOString() }],
        ['DELETE', taskPath],
      );
    }
    for (const [method, url, body] of calls) {
      const r = await who.c.call(method, url, body);
      expect(r.status, method + ' ' + url).toBe(expected);
      if (expected === 404) {
        const missing = await who.c.call(method, url.replace(path, '/api/projects/' + prefix + 'missing'), body);
        expect(missing.status).toBe(404); expect(r.json).toEqual(missing.json);
      }
      expect(await snapshot(f.id), method + ' ' + url).toEqual(before);
      probes.push({ scenario, operation: method + ' ' + url, status: r.status, state: 'UNCHANGED' });
    }
    expect((await people.leader.c.post(path + '/delete', { confirmationName: f.name })).status).toBe(200);
    const deleted = await snapshot(f.id); expect(deleted.project.deletedAt).not.toBeNull();
    for (const [method, suffix] of [['GET', ''], ['POST', '/restore'], ['POST', '/unarchive']] as const) {
      const r = await who.c.call(method, path + suffix, method === 'POST' ? {} : undefined);
      expect(r.status).toBe(404); expect(await snapshot(f.id)).toEqual(deleted);
      const missing = await who.c.call(method, '/api/projects/' + prefix + 'missing' + suffix, method === 'POST' ? {} : undefined);
      expect(missing.status).toBe(404); expect(r.json).toEqual(missing.json);
      probes.push({ scenario, operation: method + ' ' + path + suffix + ' (deleted)', status: r.status, state: 'UNCHANGED' });
    }
    completed.push(scenario);
  }, 30_000);
}

for (const scenario of ['leader', 'creator', 'admin'] as const) {
  it(`${scenario}: corresponding management operations succeed, including restore, with stored-state controls`, async () => {
    const f = await fixture(), who = people[scenario], path = `/api/projects/${f.id}`;
    const view = await who.c.get(path); expect(view.status).toBe(200); expect(view.json.project.role).toBe('LEADER');
    if (scenario === 'creator') expect(view.json.project.members.find((m: { userId: string }) => m.userId === who.id).role).toBe('EDITOR');
    if (scenario === 'admin') expect(await db.projectMember.count({ where: { projectId: f.id, userId: who.id } })).toBe(0);
    const setupActions = (await snapshot(f.id)).actions.map((a) => a.id);
    async function call(method: string, suffix: string, body: unknown, status = 200) {
      const r = await who.c.call(method, path + suffix, body);
      expect(r.status, method + ' ' + suffix).toBe(status);
      probes.push({ scenario, operation: method + ' ' + path + suffix, status: r.status });
    }
    const name = f.name + '-renamed';
    await call('PATCH', '', { name }); expect((await snapshot(f.id)).project.name).toBe(name);
    await call('POST', '/members', { userId: people.spare.id, role: 'EDITOR' }, 201);
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: f.id, userId: people.spare.id } } })).toMatchObject({ role: 'EDITOR' });
    await call('PATCH', '/members/' + people.target.id, { role: 'VIEWER' });
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: f.id, userId: people.target.id } } })).toMatchObject({ role: 'VIEWER' });
    await call('PATCH', '/members/' + people.target.id, { role: 'EDITOR' });
    await call('DELETE', '/members/' + people.spare.id, undefined, 204);
    expect(await db.projectMember.count({ where: { projectId: f.id, userId: people.spare.id } })).toBe(0);
    await call('POST', '/sections', { name: 'Allowed section' }, 201);
    const section = await db.section.findFirstOrThrow({ where: { projectId: f.id, name: 'Allowed section' } });
    await call('PATCH', '/sections/' + section.id, { name: 'Allowed section renamed' });
    expect((await db.section.findUniqueOrThrow({ where: { id: section.id } })).name).toBe('Allowed section renamed');
    await call('DELETE', '/sections/' + section.id + '?moveTo=' + f.first, undefined, 204);
    expect(await db.section.count({ where: { id: section.id } })).toBe(0);
    await call('POST', '/archive', {}); expect((await snapshot(f.id)).project.archivedAt).not.toBeNull();
    await call('POST', '/unarchive', {}); expect((await snapshot(f.id)).project.archivedAt).toBeNull();
    await call('POST', '/delete', { confirmationName: name }); expect((await snapshot(f.id)).project.deletedAt).not.toBeNull();
    await call('POST', '/restore', {}); const restored = await snapshot(f.id);
    expect(restored.project.deletedAt).toBeNull(); expect(restored.project.archivedAt).toBeNull();
    expect(restored.tasks).toEqual([f.task]);
    await call('POST', '/leader', { newLeaderId: people.target.id });
    expect(await db.projectMember.findMany({ where: { projectId: f.id, role: 'LEADER' }, select: { userId: true } })).toEqual([{ userId: people.target.id }]);
    const actions = await db.actionLog.findMany({ where: { projectId: f.id, actorId: who.id, id: { notIn: setupActions } }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['project.updated', 'project.archived', 'project.unarchived', 'project.deleted', 'project.restored', 'member.added', 'member.role_changed', 'member.removed', 'section.added', 'section.renamed', 'section.deleted']));
    completed.push(scenario);
  }, 30_000);
}

it('archived work is readable but ordinary writes leave records, versions, activity and notices unchanged', async () => {
  const f = await fixture(), path = `/api/projects/${f.id}`, taskPath = `/api/tasks/${f.task.id}`;
  expect((await people.leader.c.post(path + '/archive')).status).toBe(200);
  const before = await snapshot(f.id);
  expect(before.project.archivedAt).not.toBeNull();
  for (const who of [people.leader, people.editor, people.viewer]) {
    expect((await who.c.get(path)).status).toBe(200);
    expect((await who.c.get(taskPath)).status).toBe(200);
    expect((await who.c.get(path + '/tasks')).status).toBe(200);
  }
  expect((await people.outsider.c.get(path)).status).toBe(404);
  expect(await snapshot(f.id)).toEqual(before);

  const version = f.task.updatedAt.toISOString();
  const calls: [string, string, unknown?][] = [
    ['PATCH', path, { name: 'Denied archived rename' }],
    ['POST', path + '/members', { userId: people.spare.id, role: 'EDITOR' }],
    ['PATCH', path + '/members/' + people.target.id, { role: 'VIEWER' }],
    ['DELETE', path + '/members/' + people.target.id],
    ['POST', path + '/leader', { newLeaderId: people.target.id }],
    ['POST', path + '/sections', { name: 'Denied archived section' }],
    ['PATCH', path + '/sections/' + f.first, { name: 'Denied archived section rename' }],
    ['DELETE', path + '/sections/' + f.first + '?moveTo=' + f.second],
    ['POST', path + '/tasks', { title: 'Denied archived task', dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }],
    ['PATCH', taskPath, { title: 'Denied archived task edit', expectedUpdatedAt: version }],
    ['DELETE', taskPath],
    ['POST', taskPath + '/assign', { assigneeId: people.editor.id, expectedUpdatedAt: version }],
    ['POST', taskPath + '/move', { sectionId: f.second, expectedUpdatedAt: version }],
    ['POST', taskPath + '/complete', { expectedUpdatedAt: version }],
  ];
  for (const [method, url, body] of calls) {
    const r = await people.leader.c.call(method, url, body);
    expect(r.status, method + ' ' + url).toBe(409);
    expect(await snapshot(f.id), method + ' ' + url).toEqual(before);
    probes.push({ scenario: 'archived-leader', operation: method + ' ' + url, status: r.status, state: 'UNCHANGED' });
  }
  expect((await people.viewer.c.post(path + '/unarchive')).status).toBe(403);
  expect(await snapshot(f.id)).toEqual(before);
  expect((await people.leader.c.post(path + '/unarchive')).status).toBe(200);
  expect((await people.leader.c.patch(taskPath, { title: 'Allowed after unarchive', expectedUpdatedAt: version })).status).toBe(200);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).title).toBe('Allowed after unarchive');
  completed.push('archived-read-only');
}, 30_000);
