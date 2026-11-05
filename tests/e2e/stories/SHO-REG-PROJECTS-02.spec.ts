import { randomUUID } from 'node:crypto';
import { test, local2691 } from '../helpers/2691-admin';
import { account, task } from '../local-api';
import { expect, zz, archiveProject } from './qa';
import { newProject } from '../helpers/migration-2731';

test('SHO-REG-PROJECTS-02: leader transfer, denied candidates, deactivation and task fallback', async ({ admin, later }) => {
  if (!local2691) throw new Error('This project acceptance case uses only the guarded local test database.');
  const fixture = randomUUID();
  const people = await Promise.all(['editor', 'viewer', 'inactive', 'outsider'].map(async role => {
    const person = await account(zz(`leader ${role}`), `nakul17+zz-projects-02-${fixture}-${role}@aplyd.com`);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      if (result.status === 409) expect(result.json.error).toMatch(/already deactivated/i);
      else expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
    return person;
  }));
  const [editor, viewer, inactive, outsider] = people;
  const sentinel = await newProject(admin, later, { label: 'leader transfer sentinel' });
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
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
  await expect(page.getByText('You: Editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change leader…' })).toHaveCount(0);
  await test.info().attach('leader-transfer-screen', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
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
  await test.info().attach('leader-transfer-journey', {
    body: Buffer.from(JSON.stringify({ fixture, projectId: id, sentinelId: sentinel.id, deniedCandidates: 2, deniedActors: 2, deactivationRequiresTransfer: true, fallbackMoved: fallenBack.json.moved, sentinelPreserved: true }, null, 2)),
    contentType: 'application/json',
  });
});
