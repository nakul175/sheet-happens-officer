import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask, ymd } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

const state = (flags: string[] = []) => ({ assignee: '', flags, priority: '', sort: 'date', group: 'section' });

test('SHO-REG-PROJECTS-06: saved-view persistence, personal scope and membership loss', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This saved-view audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-saved-views-journey';
  const ownedPeople: string[] = [], ownedProjects: string[] = [];
  let projectId = '', editorId = '', adminViewId = '', editorViewId = '', viewerViewId = '', editorRemoved = false;
  let editor: Awaited<ReturnType<typeof account>> | undefined;
  let viewer: Awaited<ReturnType<typeof account>> | undefined;
  let outsiderWho: Awaited<ReturnType<typeof account>> | undefined;

  later(async () => {
    for (const id of ownedProjects) {
      const response = await admin.api.get(`/api/projects/${id}`);
      expect(response.status).toBe(200);
      expect(response.json.project.archived).toBe(true);
    }
    for (const id of ownedPeople) {
      const response = await admin.api.get(`/api/team/${id}`);
      expect(response.status).toBe(200);
      expect(response.json.person.status).toBe('DEACTIVATED');
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedPeople, ownedProjects, cleanup: true }, null, 2));
  });

  for (const role of ['editor', 'viewer', 'outsider'] as const) {
    const person = await account(zz(`saved views ${role}`), `nakul17+zz-projects-06-${fixture}-${role}@aplyd.com`);
    ownedPeople.push(person.id);
    later(async () => {
      const response = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
    });
    if (role === 'editor') editor = person;
    if (role === 'viewer') viewer = person;
    if (role === 'outsider') outsiderWho = person;
  }
  if (!editor || !viewer || !outsiderWho) throw new Error('Saved-view test people were not provisioned');
  editorId = editor.id;

  const sentinel = await newProject(admin, later, { label: 'saved views sentinel' });
  ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const project = await newProject(admin, later, { label: 'saved views journey' });
  projectId = project.id;
  ownedProjects.push(projectId);
  for (const [person, role] of [[editor, 'EDITOR'], [viewer, 'VIEWER']] as const) {
    const added = await admin.api.post(`/api/projects/${projectId}/members`, { userId: person.id, role });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  await newTask(admin, projectId, { title: zz('late saved-view task'), dueDate: ymd(-2) });

  // Registered after project archive callbacks, so views are removed while the
  // run-owned project and people are still active.
  later(async () => {
    if (editorRemoved) {
      const joined = await admin.api.post(`/api/projects/${projectId}/members`, { userId: editorId, role: 'EDITOR' });
      expect(joined.status, JSON.stringify(joined.json)).toBe(201);
      editorRemoved = false;
    }
    for (const [client, id, mayAlreadyBeGone] of [[admin.api, adminViewId, true], [editor!.c, editorViewId, false], [viewer!.c, viewerViewId, false]] as const) {
      if (!id) continue;
      const deleted = await client.del(`/api/views/${id}`);
      expect(mayAlreadyBeGone ? [204, 404] : [204]).toContain(deleted.status);
    }
    const remaining = await admin.api.get(`/api/projects/${projectId}/views`);
    expect(remaining.status).toBe(200);
    expect(remaining.json.views).toEqual([]);
    expect((await editor!.c.get(`/api/projects/${projectId}/views`)).json.views).toEqual([]);
    expect((await viewer!.c.get(`/api/projects/${projectId}/views`)).json.views).toEqual([]);
  });

  const page = admin.page;
  const originalName = zz('Owner overdue');
  const renamedName = zz('Owner urgent');
  await page.goto(`/projects/${projectId}?f=overdue`);
  await page.getByLabel('Sort').selectOption('priority');
  await page.getByRole('button', { name: 'Save view' }).click();
  await page.getByLabel('View name').fill(originalName);
  await page.getByRole('button', { name: 'Save view' }).last().click();
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: originalName })).toBeVisible();
  const adminList = await admin.api.get(`/api/projects/${projectId}/views`);
  expect(adminList.status).toBe(200);
  expect(adminList.json.views).toHaveLength(1);
  adminViewId = adminList.json.views[0].id as string;
  expect(adminList.json.views[0].state.flags).toEqual(['overdue']);
  expect(adminList.json.views[0].state.sort).toBe('priority');
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/saved.png`, fullPage: true });

  await page.goto(`/projects/${projectId}`);
  await page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: originalName }).click();
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: originalName })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Sort')).toHaveValue('priority');
  await expect(page.getByText(zz('late saved-view task')).first()).toBeVisible();
  await page.getByRole('button', { name: 'Rename view' }).click();
  await page.getByLabel('View name').fill(renamedName);
  const [renamed] = await Promise.all([
    page.waitForResponse(response => response.url().includes(`/api/views/${adminViewId}`) && response.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(renamed.status()).toBe(200);
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: renamedName })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: renamedName })).toBeVisible();
  await expect(page.getByLabel('Sort')).toHaveValue('priority');
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: originalName })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/renamed-after-reload.png`, fullPage: true });

  const editorCreated = await editor.c.post(`/api/projects/${projectId}/views`, { name: zz('Editor only'), state: state(['blocked']) });
  expect(editorCreated.status, JSON.stringify(editorCreated.json)).toBe(201);
  editorViewId = editorCreated.json.view.id as string;
  const viewerCreated = await viewer.c.post(`/api/projects/${projectId}/views`, { name: zz('Viewer only'), state: state() });
  expect(viewerCreated.status, JSON.stringify(viewerCreated.json)).toBe(201);
  viewerViewId = viewerCreated.json.view.id as string;
  expect((await admin.api.get(`/api/projects/${projectId}/views`)).json.views.map((v: { id: string }) => v.id)).toEqual([adminViewId]);
  expect((await editor.c.get(`/api/projects/${projectId}/views`)).json.views.map((v: { id: string }) => v.id)).toEqual([editorViewId]);
  expect((await viewer.c.get(`/api/projects/${projectId}/views`)).json.views.map((v: { id: string }) => v.id)).toEqual([viewerViewId]);
  expect((await outsiderWho.c.get(`/api/projects/${projectId}/views`)).status).toBe(404);
  for (const other of [editor.c, viewer.c, outsiderWho.c]) {
    expect((await other.patch(`/api/views/${adminViewId}`, { name: 'hijack' })).status).toBe(404);
    expect((await other.del(`/api/views/${adminViewId}`)).status).toBe(404);
  }
  expect((await admin.api.patch(`/api/views/${editorViewId}`, { name: 'hijack' })).status).toBe(404);

  const viewerWho = await signInAs(browser, viewer.email, PW);
  try {
    await viewerWho.page.goto(`/projects/${projectId}`);
    await expect(viewerWho.page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: zz('Viewer only') })).toBeVisible();
    await expect(viewerWho.page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: renamedName })).toHaveCount(0);
  } finally { await viewerWho.ctx.close(); }

  const removed = await admin.api.del(`/api/projects/${projectId}/members/${editorId}?handoverTo=${admin.user.id}`);
  expect(removed.status, JSON.stringify(removed.json)).toBe(204);
  editorRemoved = true;
  expect((await editor.c.get(`/api/projects/${projectId}/views`)).status).toBe(404);
  expect((await editor.c.post(`/api/projects/${projectId}/views`, { name: 'after removal', state: state() })).status).toBe(404);
  expect((await editor.c.patch(`/api/views/${editorViewId}`, { name: 'after removal' })).status).toBe(404);
  const readded = await admin.api.post(`/api/projects/${projectId}/members`, { userId: editorId, role: 'EDITOR' });
  expect(readded.status, JSON.stringify(readded.json)).toBe(201);
  editorRemoved = false;
  expect((await editor.c.get(`/api/projects/${projectId}/views`)).json.views).toMatchObject([{ id: editorViewId, name: zz('Editor only') }]);

  await page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: renamedName }).click();
  await page.getByRole('button', { name: 'Delete view' }).click();
  await page.getByRole('button', { name: 'Delete view' }).last().click();
  await page.reload();
  await expect(page.getByRole('group', { name: 'Saved views' }).getByRole('button', { name: renamedName })).toHaveCount(0);
  expect((await admin.api.get(`/api/projects/${projectId}/views`)).json.views).toEqual([]);
  expect((await editor.c.get(`/api/projects/${projectId}/views`)).json.views.map((v: { id: string }) => v.id)).toEqual([editorViewId]);
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId, adminViewId, editorViewId, viewerViewId, savedFilterAndSortAfterReload: true, renamedAndReloaded: true, deletedAndReloaded: true, rolePersonalScope: true, foreignMutationsDenied: true, removedMemberDenied: true, viewerAllowed: true, sentinelFingerprint, sentinelPreserved: true }, null, 2));
});
