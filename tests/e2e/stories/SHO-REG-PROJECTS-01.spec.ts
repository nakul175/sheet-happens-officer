import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account } from '../local-api';
import { expect, zz, archiveProject } from './qa';
import { newProject } from '../helpers/migration-2731';

test('SHO-REG-PROJECTS-01 API: create, edit, reload, activity and validation', async ({ admin, later }) => {
  if (!local2691) throw new Error('This project acceptance case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-create-edit-journey';
  const ownedProjects: string[] = [];
  let outsiderId = '';
  later(async () => {
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    if (outsiderId) {
      const result = await admin.api.get(`/api/team/${outsiderId}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe('DEACTIVATED');
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedProjects, outsiderId, cleanup: true }, null, 2));
  });
  const sentinel = await newProject(admin, later, { label: 'project create edit sentinel' }); ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const p = await newProject(admin, later, { label: 'project create edit reload' });
  ownedProjects.push(p.id);
  const outsider = await account(zz('project outsider'), `nakul17+zz-projects-01-${randomUUID()}@aplyd.com`);
  outsiderId = outsider.id;
  later(() => admin.api.post(`/api/team/${outsider.id}/deactivate`, { reassign: 'leaders' }));
  const memberIds: string[] = [];
  later(async () => {
    for (const id of memberIds) {
      const result = await admin.api.get(`/api/team/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe('DEACTIVATED');
    }
  });
  const members: { person: Awaited<ReturnType<typeof account>>; role: string }[] = [];
  for (const role of ['EDITOR', 'VIEWER'] as const) {
    const person = await account(zz(`project ${role.toLowerCase()}`), `nakul17+zz-projects-01-${fixture}-${role.toLowerCase()}@aplyd.com`);
    memberIds.push(person.id);
    later(() => admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' }));
    expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: person.id, role })).status).toBe(201);
    members.push({ person, role });
  }
  const ordinaryCreator = members.find(member => member.role === 'EDITOR')!.person;
  const ordinaryCreated = await ordinaryCreator.c.post('/api/projects', { name: zz('Ordinary created project'), leaderId: ordinaryCreator.id });
  expect(ordinaryCreated.status, JSON.stringify(ordinaryCreated.json)).toBe(201);
  const ordinaryProjectId = ordinaryCreated.json.project.id as string;
  ownedProjects.push(ordinaryProjectId);
  later(() => archiveProject(admin.api, ordinaryProjectId, admin.user.id));
  const ordinaryDetail = await admin.api.get(`/api/projects/${ordinaryProjectId}`);
  expect(ordinaryDetail.status).toBe(200);
  expect(ordinaryDetail.json.project.members.filter((member: { role: string }) => member.role === 'LEADER').map((member: { userId: string }) => member.userId)).toEqual([ordinaryCreator.id]);
  const beforeInvalidCreates = await admin.api.get('/api/projects');
  for (const body of [{ name: '   ' }, { name: 'x'.repeat(201) }, { name: zz('Invalid description'), description: 'x'.repeat(5001) }]) {
    expect((await admin.api.post('/api/projects', { ...body, leaderId: admin.user.id })).status).toBe(400);
  }
  expect((await admin.api.get('/api/projects')).json).toEqual(beforeInvalidCreates.json);
  const name = zz('Renamed project');
  const changed = await admin.api.patch(`/api/projects/${p.id}`, { name, description: 'A persisted project description' });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);

  const detail = await admin.api.get(`/api/projects/${p.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.project).toMatchObject({ id: p.id, name, description: 'A persisted project description' });
  expect(detail.json.project.members.filter((m: { role: string }) => m.role === 'LEADER')).toHaveLength(1);
  expect(detail.json.project.sections.map((s: { name: string }) => s.name)).toEqual(['To do', 'In progress', 'Done']);
  const listed = await admin.api.get('/api/projects');
  expect(listed.json.projects.filter((row: { id: string }) => row.id === p.id)).toHaveLength(1);
  const activity = await admin.api.get(`/api/projects/${p.id}/activity`);
  expect(activity.status).toBe(200);
  expect(activity.json.items.some((row: { kind: string }) => row.kind === 'project.created')).toBe(true);
  expect(activity.json.items.some((row: { kind: string }) => row.kind === 'project.updated')).toBe(true);

  for (const body of [{ name: '   ' }, { name: 'x'.repeat(201) }, { description: 'x'.repeat(5001) }]) {
    expect((await admin.api.patch(`/api/projects/${p.id}`, body)).status).toBe(400);
  }
  const beforeDenied = await admin.api.get(`/api/projects/${p.id}`);
  const beforeDeniedActivity = await admin.api.get(`/api/projects/${p.id}/activity`);
  for (const { person, role } of members) {
    expect((await person.c.get(`/api/projects/${p.id}`)).status, `${role} can read the project`).toBe(200);
    expect((await person.c.patch(`/api/projects/${p.id}`, { name: 'Unauthorized' })).status, `${role} cannot rename it`).toBe(403);
  }
  expect((await outsider.c.patch(`/api/projects/${p.id}`, { name: 'Unauthorized' })).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${p.id}`)).json.project).toEqual(beforeDenied.json.project);
  expect((await admin.api.get(`/api/projects/${p.id}/activity`)).json).toEqual(beforeDeniedActivity.json);
  expect((await admin.api.get(`/api/projects/${p.id}`)).json.project).toMatchObject({ name, description: 'A persisted project description' });
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: p.id, ordinaryProjectId, sentinelId: sentinel.id, sentinelFingerprint, sentinelPreserved: true, createValidationRejected: 3, editValidationRejected: 3, ordinaryCreateWithOneLeader: true, editorViewerReadAllowed: true, editorViewerRenameDenied: true, deniedWritesLeftProjectAndActivityUnchanged: true, outsiderDenied: true }, null, 2));
});

test('SHO-REG-PROJECTS-01 screen: create, edit, reload and inspect details', async ({ admin, later }) => {
  const page = admin.page;
  const originalName = zz('Screen project');
  const updatedName = zz('Screen project renamed');
  await page.goto('/projects/new');
  await page.getByLabel('Project name *').fill(originalName);
  await page.getByLabel('Description (optional)').fill('Initial description');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/?]+\?new=1/);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  later(() => archiveProject(admin.api, id, admin.user.id));
  expect((await admin.api.get(`/api/projects/${id}`)).json.project).toMatchObject({ name: originalName, description: 'Initial description' });

  await page.goto(`/projects/${id}/members`);
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.getByLabel('Project name').fill(updatedName);
  await page.getByLabel('Description').fill('Updated description');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(updatedName, { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(updatedName, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Updated description', { exact: true })).toBeVisible();
  expect((await admin.api.get(`/api/projects/${id}`)).json.project).toMatchObject({ name: updatedName, description: 'Updated description' });
  mkdirSync('test-results/project-create-edit-journey', { recursive: true });
  await page.screenshot({ path: 'test-results/project-create-edit-journey/edited-settings.png', fullPage: true });
  await page.goto(`/projects/${id}/activity`);
  await expect(page.getByText(/renamed the project/i).first()).toBeVisible();
});
