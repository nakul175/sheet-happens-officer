import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, task, PW } from '../local-api';
import { expect, zz, archiveProject, BASE_URL } from './qa';
import { newProject } from '../helpers/migration-2731';

test('SHO-REG-PROJECTS-02: leader transfer, denied candidates, deactivation and task fallback', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This project acceptance case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-leader-transfer';
  const ownedPeople: string[] = [];
  const ownedProjects: string[] = [];
  // Registered first, so the strict LIFO fixture checks after all owned cleanup callbacks.
  later(async () => {
    const people = await Promise.all(ownedPeople.map(async id => {
      const result = await admin.api.get(`/api/team/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe('DEACTIVATED');
      return id;
    }));
    const projects = await Promise.all(ownedProjects.map(async id => {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
      return id;
    }));
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, people, projects, cleanup: true }, null, 2));
  });
  const people = await Promise.all(['editor', 'viewer', 'inactive', 'outsider'].map(async role => {
    const person = await account(zz(`leader ${role}`), `nakul17+zz-projects-02-${fixture}-${role}@aplyd.com`);
    ownedPeople.push(person.id);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      if (result.status === 409) expect(result.json.error).toMatch(/already deactivated/i);
      else expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
    return person;
  }));
  const [editor, viewer, inactive, outsider] = people;
  const sentinel = await newProject(admin, later, { label: 'leader transfer sentinel' });
  ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const created = await admin.api.post('/api/projects', {
    name: zz('leader transfer journey'), leaderId: admin.user.id,
    members: [
      { userId: editor.id, role: 'EDITOR' },
      { userId: viewer.id, role: 'VIEWER' },
      { userId: inactive.id, role: 'EDITOR' },
    ],
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.project.id as string;
  ownedProjects.push(id);
  later(() => archiveProject(admin.api, id, admin.user.id));
  const detail = async () => {
    const response = await admin.api.get(`/api/projects/${id}`);
    expect(response.status).toBe(200);
    return response.json.project as { members: { userId: string; role: string; active: boolean }[] };
  };
  const expectLeader = async (userId: string) => {
    const leaders = (await detail()).members.filter(m => m.role === 'LEADER');
    expect(leaders.map(m => m.userId)).toEqual([userId]);
    expect(leaders[0].active).toBe(true);
  };

  expect((await admin.api.post(`/api/team/${inactive.id}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
  for (const userId of [inactive.id, outsider.id]) {
    expect((await admin.api.post(`/api/projects/${id}/leader`, { newLeaderId: userId, previousRole: 'EDITOR' })).status).toBe(400);
    await expectLeader(admin.user.id);
  }
  for (const person of [editor, viewer]) {
    expect((await person.c.post(`/api/projects/${id}/leader`, { newLeaderId: person.id, previousRole: 'EDITOR' })).status).toBe(403);
    await expectLeader(admin.user.id);
  }
  const leadershipButtonFor = async (person: typeof editor, visible: boolean) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      expect((await context.request.post('/api/auth/signin', { data: { email: person.email, password: PW } })).status()).toBe(200);
      const rolePage = await context.newPage();
      await rolePage.goto(`/projects/${id}/members`);
      await expect(rolePage.locator('.settings-members')).toBeVisible();
      if (visible) await expect(rolePage.getByRole('button', { name: 'Change leader…' })).toBeVisible();
      else await expect(rolePage.getByRole('button', { name: 'Change leader…' })).toHaveCount(0);
    } finally { await context.close(); }
  };
  await leadershipButtonFor(editor, false);
  await leadershipButtonFor(viewer, false);

  const page = admin.page;
  await page.goto(`/projects/${id}/members`);
  await page.getByRole('button', { name: 'Change leader…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change leader' });
  const candidate = dialog.getByLabel('New leader');
  await expect(candidate.locator(`option[value="${viewer.id}"]`)).toHaveCount(1);
  await expect(candidate.locator(`option[value="${inactive.id}"]`)).toHaveCount(0);
  await expect(candidate.locator(`option[value="${outsider.id}"]`)).toHaveCount(0);
  await candidate.selectOption(viewer.id);
  await dialog.getByRole('button', { name: 'Change leader' }).click();
  await expect.poll(async () => (await detail()).members.find(m => m.role === 'LEADER')?.userId).toBe(viewer.id);
  await page.reload();
  const roster = page.locator('.settings-members');
  await expect(roster.getByText(viewer.name, { exact: true }).locator('xpath=../..').getByText('Leader', { exact: true })).toBeVisible();
  // The Super Admin retains effective management access; the membership chip is the stored role.
  await expect(roster.getByRole('combobox', { name: `Role of ${admin.user.name}` })).toHaveValue('EDITOR');
  await leadershipButtonFor(viewer, true);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/roster.png`, fullPage: true });
  await expectLeader(viewer.id);

  const work = await task(viewer, id, { title: zz('leader fallback work'), assigneeId: viewer.id });
  const refused = await admin.api.post(`/api/team/${viewer.id}/deactivate`, { reassign: 'leaders' });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain('Name a new Leader first');
  await expectLeader(viewer.id);
  expect((await viewer.c.get(`/api/tasks/${work}`)).json.task.assignee.id).toBe(viewer.id);

  const transferred = await admin.api.post(`/api/projects/${id}/leader`, { newLeaderId: editor.id, previousRole: 'EDITOR' });
  expect(transferred.status, JSON.stringify(transferred.json)).toBe(200);
  await expectLeader(editor.id);
  const fallenBack = await admin.api.post(`/api/team/${viewer.id}/deactivate`, { reassign: outsider.id });
  expect(fallenBack.status, JSON.stringify(fallenBack.json)).toBe(200);
  expect(fallenBack.json).toMatchObject({ moved: 1, fellBack: [created.json.project.name] });
  expect((await admin.api.get(`/api/tasks/${work}`)).json.task.assignee.id).toBe(editor.id);
  await expectLeader(editor.id);
  const final = await detail();
  expect(final.members.find(m => m.userId === viewer.id)).toMatchObject({ role: 'EDITOR', active: false });
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(sentinelAfter).toMatchObject({ id: sentinelBefore.id, name: sentinelBefore.name });
  expect(sentinelAfter.members).toEqual(sentinelBefore.members);
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: id, sentinelId: sentinel.id, deniedCandidates: 2, deniedActors: 2, deniedActorScreens: 2, promotedViewerScreen: true, deactivationRequiresTransfer: true, fallbackMoved: fallenBack.json.moved, sentinelFingerprint, sentinelPreserved: true }, null, 2));
});
