import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-PROJECTS-04 partial: task Trash route and signed-in restore controls', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This Trash audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-trash-journey';
  const ownedPeople: string[] = [], ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedPeople) {
      const result = await admin.api.get(`/api/team/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe('DEACTIVATED');
    }
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedPeople, ownedProjects, cleanup: true }, null, 2));
  });
  const people = await Promise.all(['editor', 'viewer', 'outsider'].map(async role => {
    const person = await account(zz(`Trash ${role}`), `nakul17+zz-projects-04-${fixture}-${role}@aplyd.com`);
    ownedPeople.push(person.id);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
    return person;
  }));
  const [editor, viewer, outsider] = people;
  const sentinel = await newProject(admin, later, { label: 'Trash sentinel' }); ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const project = await newProject(admin, later, { label: 'Trash journey' }); ownedProjects.push(project.id);
  for (const [person, role] of [[editor, 'EDITOR'], [viewer, 'VIEWER']] as const) {
    const added = await admin.api.post(`/api/projects/${project.id}/members`, { userId: person.id, role });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  const firstTitle = zz('restore from Trash');
  const firstId = await newTask(admin, project.id, { title: firstTitle });
  expect((await admin.api.del(`/api/tasks/${firstId}`)).status).toBe(204);
  expect((await admin.api.get(`/api/tasks/${firstId}`)).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${project.id}/trash`)).json.items.map((item: { id: string }) => item.id)).toContain(firstId);

  const page = admin.page;
  await page.goto(`/projects/${project.id}/trash`);
  await expect(page.getByText('Tasks are kept for 30 days, then permanently removed.')).toBeVisible();
  const firstRow = page.getByRole('row', { name: new RegExp(firstTitle) });
  await expect(firstRow).toBeVisible();
  await expect(firstRow.getByRole('button', { name: 'Restore' })).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/leader-trash.png`, fullPage: true });
  await firstRow.getByRole('button', { name: 'Restore' }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${firstId}`)).status).toBe(200);
  await expect(page.getByRole('row', { name: new RegExp(firstTitle) })).toHaveCount(0);

  const secondTitle = zz('role-gated Trash');
  const secondId = await newTask(admin, project.id, { title: secondTitle });
  expect((await admin.api.del(`/api/tasks/${secondId}`)).status).toBe(204);
  for (const person of [editor, viewer]) {
    const who = await signInAs(browser, person.email, PW);
    try {
      await who.page.goto(`/projects/${project.id}/trash`);
      const row = who.page.getByRole('row', { name: new RegExp(secondTitle) });
      await expect(row).toBeVisible();
      await expect(row.getByRole('button', { name: 'Restore' })).toHaveCount(0);
      await expect(who.page.getByText('Only the project Leader can restore deleted tasks.')).toBeVisible();
      expect((await who.api.post(`/api/tasks/${secondId}/restore`, {})).status).toBe(403);
      if (person.id === viewer.id) await who.page.screenshot({ path: `${evidenceDir}/viewer-trash.png`, fullPage: true });
    } finally { await who.ctx.close(); }
  }
  expect((await outsider.c.get(`/api/projects/${project.id}/trash`)).status).toBe(404);
  expect((await outsider.c.post(`/api/tasks/${secondId}/restore`, {})).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${project.id}/trash`)).json.items.map((item: { id: string }) => item.id)).toContain(secondId);
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, firstId, secondId, leaderRestored: true, editorDenied: true, viewerDenied: true, outsiderHidden: true, secondRetained: true, sentinelFingerprint, sentinelPreserved: true }, null, 2));
});
