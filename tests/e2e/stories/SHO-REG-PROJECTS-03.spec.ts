import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask } from '../helpers/migration-2731';
import { BASE_URL, expect, zz } from './qa';

test('SHO-REG-PROJECTS-03: eight-section limit, persistent reorder and populated deletion', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This project acceptance case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-sections-journey';
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
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, people: ownedPeople, projects: ownedProjects, cleanup: true }, null, 2));
  });
  const people = await Promise.all(['editor', 'viewer', 'outsider'].map(async role => {
    const person = await account(zz(`section ${role}`), `nakul17+zz-projects-03-${fixture}-${role}@aplyd.com`);
    ownedPeople.push(person.id);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
    return person;
  }));
  const [editor, viewer, outsider] = people;
  const sentinel = await newProject(admin, later, { label: 'sections sentinel' }); ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const project = await newProject(admin, later, { label: 'sections journey' }); ownedProjects.push(project.id);
  for (const [person, role] of [[editor, 'EDITOR'], [viewer, 'VIEWER']] as const) {
    const added = await admin.api.post(`/api/projects/${project.id}/members`, { userId: person.id, role });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    expect((await person.c.post(`/api/projects/${project.id}/sections`, { name: 'Denied' })).status).toBe(403);
  }
  expect((await outsider.c.get(`/api/projects/${project.id}`)).status).toBe(404);
  expect((await outsider.c.post(`/api/projects/${project.id}/sections`, { name: 'Denied' })).status).toBe(404);
  const names = ['Audit source', 'Audit moving', 'Audit extra one', 'Audit extra two'];
  const added: { id: string; name: string }[] = [];
  for (const name of names) {
    const result = await admin.api.post(`/api/projects/${project.id}/sections`, { name });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    added.push(result.json.section as { id: string; name: string });
  }
  const taskId = await newTask(admin, project.id, { title: zz('section retention task'), sectionId: added[0].id });
  const sections = async () => (await admin.api.get(`/api/projects/${project.id}`)).json.project.sections as { id: string; name: string; position: number }[];
  expect(await sections()).toHaveLength(7);

  for (const person of people) {
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      expect((await context.request.post('/api/auth/signin', { data: { email: person.email, password: PW } })).status()).toBe(200);
      const rolePage = await context.newPage();
      await rolePage.goto(`/projects/${project.id}`);
      await expect(rolePage.getByRole('button', { name: '+ Add section' })).toHaveCount(0);
      await expect(rolePage.getByRole('button', { name: 'Section menu for Audit source' })).toHaveCount(0);
    } finally { await context.close(); }
  }

  const page = admin.page;
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: '+ Add section' }).click();
  await page.getByLabel('Section name').fill('Audit eighth');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect.poll(async () => (await sections()).length).toBe(8);
  await expect(page.getByRole('button', { name: '+ Add section' })).toBeDisabled();
  await expect(page.getByText('A project can have up to 8 sections.')).toBeVisible();
  for (const name of ['Audit ninth one', 'Audit ninth two']) {
    const denied = await admin.api.post(`/api/projects/${project.id}/sections`, { name });
    expect(denied.status).toBe(409);
  }
  expect(await sections()).toHaveLength(8);
  const raceProject = await newProject(admin, later, { label: 'sections HTTP race' }); ownedProjects.push(raceProject.id);
  for (let n = 0; n < 4; n++) {
    const result = await admin.api.post(`/api/projects/${raceProject.id}/sections`, { name: `Race setup ${n}` });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
  }
  const raced = await Promise.all(['a', 'b'].map(suffix => admin.api.post(`/api/projects/${raceProject.id}/sections`, { name: `Race eighth ${suffix}` })));
  expect(raced.map(result => result.status).sort()).toEqual([201, 409]);
  const raceSections = (await admin.api.get(`/api/projects/${raceProject.id}`)).json.project.sections as { position: number }[];
  expect(raceSections).toHaveLength(8);
  expect(raceSections.map(section => section.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

  await page.getByRole('button', { name: 'Section menu for Audit moving' }).click();
  await page.getByRole('menuitem', { name: 'Move left' }).click();
  await expect.poll(async () => (await sections()).findIndex(s => s.id === added[1].id)).toBe(3);
  await page.reload();
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await expect(page.locator('.col')).toHaveCount(8);
  expect(await page.locator('.col').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual((await sections()).map(s => s.name));
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/reordered-board.png`, fullPage: true });

  const noDestination = await admin.api.del(`/api/projects/${project.id}/sections/${added[0].id}`);
  expect(noDestination.status).toBe(400);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).status).toBe(200);
  await page.getByRole('button', { name: 'Section menu for Audit source' }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect(page.getByText('This section has 1 task. Choose where they go.')).toBeVisible();
  await page.getByLabel('Move its tasks to').selectOption(project.todo);
  await page.getByRole('button', { name: 'Delete section' }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.sectionId).toBe(project.todo);
  await expect.poll(async () => (await sections()).length).toBe(7);
  await page.reload();
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await expect(page.locator('.col[aria-label="Audit source"]')).toHaveCount(0);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.title).toBe(zz('section retention task'));
  const final = await sections();
  expect(final.map(section => section.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, raceProjectId: raceProject.id, taskId, initialSections: 7, afterAdd: 8, deniedNinth: 2, concurrentHttp: [201, 409], reorderedSection: added[1].id, deletedSection: added[0].id, movedTaskTo: project.todo, finalSections: 7, sentinelFingerprint, sentinelPreserved: true }, null, 2));
});
