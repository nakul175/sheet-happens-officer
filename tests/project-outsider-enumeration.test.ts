import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assertLocalFixture } from './e2e/local-fixture-guard';
import { BASE, zzTestData } from './e2e/local-api';

const fixture = zzTestData('access01-projects');
const evidenceDir = 'test-results/project-outsider-enumeration';
const missing = `zz-missing-${Date.now().toString(36)}`;
let safe = false;

type Reply = { status: number; body: string };
async function send(cookie: string, method: string, path: string, value?: object): Promise<Reply> {
  const response = await fetch(BASE + path, {
    method,
    headers: { cookie, ...(value ? { 'content-type': 'application/json' } : {}) },
    body: value ? JSON.stringify(value) : undefined,
  });
  return { status: response.status, body: await response.text() };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(projectIds: string[]) {
  return {
    projects: await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, archivedAt: true, deletedAt: true, updatedAt: true }, orderBy: { id: 'asc' } }),
    sections: await db.section.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, projectId: true, name: true, position: true, isDone: true }, orderBy: { id: 'asc' } }),
    tasks: await db.task.count({ where: { projectId: { in: projectIds } } }),
    members: await db.projectMember.count({ where: { projectId: { in: projectIds } } }),
    actions: await db.actionLog.count({ where: { projectId: { in: projectIds } } }),
  };
}

beforeAll(() => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  safe = true;
});

afterAll(async () => {
  if (!safe) return;
  const problems = await fixture.cleanUp();
  expect(problems).toEqual([]);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ ownedProjectsArchived: true, ownedUsersDeactivated: true, cleanup: true }, null, 2));
});

it('returns the same 404 for outsider and missing project IDs without changing stored state', async () => {
  const leader = await fixture.person('leader');
  const outsider = await fixture.person('outsider');
  const project = await fixture.project(leader);
  const sentinel = await fixture.project(leader);
  const before = digest(await snapshot([project.id, sentinel.id]));
  const cases: { method: string; path: (id: string) => string; value?: object }[] = [
    { method: 'GET', path: (id) => `/api/projects/${id}` },
    { method: 'GET', path: (id) => `/api/projects/${id}/activity` },
    { method: 'GET', path: (id) => `/api/projects/${id}/notes` },
    { method: 'GET', path: (id) => `/api/projects/${id}/people?q=zz` },
    { method: 'GET', path: (id) => `/api/projects/${id}/assignment-people?q=zz` },
    { method: 'GET', path: (id) => `/api/projects/${id}/views` },
    { method: 'GET', path: (id) => `/api/projects/${id}/tasks` },
    { method: 'GET', path: (id) => `/api/projects/${id}/trash` },
    { method: 'PATCH', path: (id) => `/api/projects/${id}`, value: { name: 'ZZ-TEST outsider edit' } },
    { method: 'POST', path: (id) => `/api/projects/${id}/sections`, value: { name: 'ZZ-TEST outsider section' } },
    { method: 'PATCH', path: (id) => `/api/projects/${id}/sections/${project.todo}`, value: { name: 'ZZ-TEST outsider rename' } },
    { method: 'DELETE', path: (id) => `/api/projects/${id}/sections/${project.todo}?moveTo=${project.doing}` },
    { method: 'POST', path: (id) => `/api/projects/${id}/tasks`, value: { title: 'ZZ-TEST outsider task', dueDate: '2030-01-01' } },
    { method: 'POST', path: (id) => `/api/projects/${id}/archive`, value: {} },
  ];
  for (const [index, item] of cases.entries()) {
    const absent = await send(outsider.c.cookie, item.method, item.path(missing), item.value);
    const hidden = await send(outsider.c.cookie, item.method, item.path(project.id), item.value);
    expect(hidden.status, `route ${index + 1} ${item.method} ${item.path('ID')}`).toBe(404);
    expect(hidden, `route ${index + 1} ${item.method} ${item.path('ID')}`).toEqual(absent);
    expect(hidden.body).not.toContain(project.name);
  }
  expect((await send('', 'GET', `/api/projects/${project.id}`)).status).toBe(401);
  expect(digest(await snapshot([project.id, sentinel.id]))).toBe(before);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ comparedRoutes: cases.length, outsiderMissingResponsesEquivalent: true, signedOutDenied: true, projectAndSentinelFingerprint: before, storedStatePreserved: true }, null, 2));
});
