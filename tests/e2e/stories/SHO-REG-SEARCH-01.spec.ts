import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-SEARCH-01 partial: archived organisation contacts follow Include archived', async ({ admin, later }) => {
  if (!local2691) throw new Error('This search audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-archive-contact';
  const ownedOrganisations: string[] = [];
  later(async () => {
    for (const id of ownedOrganisations) {
      const result = await admin.api.get(`/api/orgs/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.organisation.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedOrganisations, cleanup: true }, null, 2));
  });
  async function organisation(label: string) {
    const result = await admin.api.post('/api/orgs', { name: zz(label) });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    const id = result.json.organisation.id as string;
    ownedOrganisations.push(id);
    later(async () => {
      const current = await admin.api.get(`/api/orgs/${id}`);
      if (current.status === 200 && !current.json.organisation.archived) {
        expect((await admin.api.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
      }
    });
    return id;
  }
  const activeOrg = await organisation('Search active');
  const archivedOrg = await organisation('Search archived');
  const query = zz('search archived contact');
  async function contact(orgId: string) {
    const result = await admin.api.post(`/api/orgs/${orgId}/contacts`, { name: query });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    return result.json.contact.id as string;
  }
  const activeContact = await contact(activeOrg);
  const archivedContact = await contact(archivedOrg);
  expect((await admin.api.post(`/api/orgs/${archivedOrg}/archive`, { archive: true })).status).toBe(200);

  const search = async (archived: boolean) => {
    const result = await admin.api.get(`/api/search?q=${encodeURIComponent(query)}${archived ? '&archived=true' : ''}`);
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    return result.json.contacts as { id: string; organisation: { id: string } }[];
  };
  expect((await search(false)).map(row => row.id)).toEqual([activeContact]);
  expect((await search(true)).map(row => row.id).sort()).toEqual([activeContact, archivedContact].sort());

  const page = admin.page;
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search' }).fill(query);
  await expect(page.locator(`a.item[href="/accounts/${activeOrg}"]`)).toBeVisible();
  await expect(page.locator(`a.item[href="/accounts/${archivedOrg}"]`)).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/archived-off.png`, fullPage: true });
  await page.getByRole('checkbox', { name: 'Include archived' }).check();
  await expect(page.locator(`a.item[href="/accounts/${archivedOrg}"]`)).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/archived-on.png`, fullPage: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, activeOrg, archivedOrg, activeContact, archivedContact, defaultActiveOnly: true, archivedIncludedOnlyWhenSelected: true, uiMatchesApi: true }, null, 2));
});

test('SHO-REG-SEARCH-01 partial: Member search excludes foreign and trashed tasks', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This search permission audit uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-permission-boundary';
  const projects: string[] = [];
  let memberId = '';
  later(async () => {
    for (const id of projects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    const person = await admin.api.get(`/api/team/${memberId}`);
    expect(person.status).toBe(200);
    expect(person.json.person.status).toBe('DEACTIVATED');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projects, memberId, cleanup: true }, null, 2));
  });

  const identity = await account(zz('Search member'), `nakul17+zz-search-boundary-${fixture}@aplyd.com`);
  memberId = identity.id;
  later(async () => {
    expect((await admin.api.post(`/api/team/${memberId}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
    expect((await identity.c.post('/api/auth/signout')).status).toBe(204);
  });
  const member = await signInAs(browser, identity.email, PW);
  later(() => member.ctx.close());

  const owned = await newProject(admin, later, { label: 'Search owned', members: [{ who: member, role: 'VIEWER' }] }); projects.push(owned.id);
  const foreign = await newProject(admin, later, { label: 'Search foreign' }); projects.push(foreign.id);
  const sentinel = await newProject(admin, later, { label: 'Search unrelated sentinel' }); projects.push(sentinel.id);
  const query = zz(`search boundary ${fixture.slice(0, 8)}`);
  const ownTask = await newTask(admin, owned.id, { title: `${query} own` });
  const foreignTask = await newTask(admin, foreign.id, { title: `${query} foreign` });
  const trashedTask = await newTask(admin, owned.id, { title: `${query} trash` });
  const sentinelTask = await newTask(admin, sentinel.id, { title: zz(`unrelated sentinel ${fixture.slice(0, 8)}`) });
  const sentinelBefore = await admin.api.get(`/api/tasks/${sentinelTask}`);
  expect(sentinelBefore.status).toBe(200);
  expect((await admin.api.del(`/api/tasks/${trashedTask}`)).status).toBe(204);

  const response = await member.api.get(`/api/search?q=${encodeURIComponent(query)}`);
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const visible = (response.json.tasks as { id: string }[]).map(row => row.id);
  expect(visible).toContain(ownTask);
  expect(visible).not.toContain(foreignTask);
  expect(visible).not.toContain(trashedTask);

  await member.page.goto('/search');
  await member.page.getByRole('searchbox', { name: 'Search' }).fill(query);
  await expect(member.page.locator(`a.item[href="/projects/${owned.id}?task=${ownTask}"]`)).toBeVisible();
  await expect(member.page.locator(`a.item[href="/projects/${foreign.id}?task=${foreignTask}"]`)).toHaveCount(0);
  await expect(member.page.locator(`a.item[href="/projects/${owned.id}?task=${trashedTask}"]`)).toHaveCount(0);
  const sentinelAfter = await admin.api.get(`/api/tasks/${sentinelTask}`);
  expect(sentinelAfter.status).toBe(200);
  expect(sentinelAfter.json.task).toEqual(sentinelBefore.json.task);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, memberId, ownedProject: owned.id, foreignProject: foreign.id, sentinelProject: sentinel.id, ownTask, foreignTask, trashedTask, sentinelTask, unrelatedSentinelUnchanged: true, apiVisibleOwnOnly: true, browserVisibleOwnOnly: true }, null, 2));
});

test('SHO-REG-SEARCH-01 partial: Ideas only matches API and browser task results', async ({ admin, later }) => {
  if (!local2691) throw new Error('This search audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-ideas-only';
  let projectId = '';
  later(async () => {
    const stored = await admin.api.get(`/api/projects/${projectId}`);
    expect(stored.status).toBe(200);
    expect(stored.json.project.archived).toBe(true);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projectId, projectArchived: true }, null, 2));
  });
  const project = await newProject(admin, later, { label: 'Search ideas filter' });
  projectId = project.id;
  const query = zz(`search ideas ${fixture.slice(0, 8)}`);
  const idea = await newTask(admin, project.id, { title: `${query} idea` });
  const ordinary = await newTask(admin, project.id, { title: `${query} ordinary` });
  const marked = await admin.api.post(`/api/tasks/${idea}/idea`, { isIdea: true });
  expect(marked.status, JSON.stringify(marked.json)).toBe(200);

  const ids = async (ideasOnly: boolean) => {
    const response = await admin.api.get(`/api/search?q=${encodeURIComponent(query)}${ideasOnly ? '&idea=true' : ''}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return (response.json.tasks as { id: string }[]).map(row => row.id);
  };
  expect((await ids(false)).sort()).toEqual([idea, ordinary].sort());
  expect(await ids(true)).toEqual([idea]);

  const page = admin.page;
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search' }).fill(query);
  const ideaLink = page.locator(`a.item[href="/projects/${project.id}?task=${idea}"]`);
  const ordinaryLink = page.locator(`a.item[href="/projects/${project.id}?task=${ordinary}"]`);
  await expect(ideaLink).toBeVisible();
  await expect(ordinaryLink).toBeVisible();
  await page.getByRole('checkbox', { name: 'Ideas only' }).check();
  await expect(ideaLink).toBeVisible();
  await expect(ordinaryLink).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, idea, ordinary, apiMatchesBrowser: true }, null, 2));
});
