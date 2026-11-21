import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-SEARCH-03: default search works without pg_trgm or ranked payload', async ({ admin, later }) => {
  if (!local2691) throw new Error('This activation audit uses only the guarded local test database.');
  const evidenceDir = 'test-results/search-stage-a-off';
  let projectId = '';
  later(async () => {
    if (!projectId) return;
    const stored = await admin.api.get(`/api/projects/${projectId}`);
    expect(stored.status).toBe(200);
    expect(stored.json.project.archived).toBe(true);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ projectId, projectArchived: true }, null, 2));
  });
  const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  try {
    const extensions = await database.query<{ count: string }>("SELECT count(*)::bigint AS count FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(Number(extensions.rows[0]?.count)).toBe(0);
  } finally {
    await database.end();
  }
  const project = await newProject(admin, later, { label: 'Search Stage A disabled' });
  projectId = project.id;
  const query = zz(`stage a off ${randomUUID().slice(0, 8)}`);
  const taskId = await newTask(admin, project.id, { title: query });
  const response = await admin.api.get(`/api/search?q=${encodeURIComponent(query)}`);
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  expect((response.json.tasks as { id: string }[]).map((task) => task.id)).toContain(taskId);
  expect(response.json).not.toHaveProperty('hits');
  await admin.page.goto('/search');
  await admin.page.getByRole('searchbox', { name: 'Search' }).fill(query);
  await expect(admin.page.locator(`a.item[href="/projects/${project.id}?task=${taskId}"]`)).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ projectId: project.id, taskId, pgTrgmInstalled: false, legacyApiPayload: true, browserResult: true }, null, 2));
});

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

  // Archive and idea toggles must not widen a Member's task boundary or leak a trashed hit.
  for (const archived of [false, true]) {
    for (const ideasOnly of [false, true]) {
      const flags = `${archived ? '&archived=true' : ''}${ideasOnly ? '&idea=true' : ''}`;
      const response = await member.api.get(`/api/search?q=${encodeURIComponent(query)}${flags}`);
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      const visible = (response.json.tasks as { id: string }[]).map(row => row.id);
      if (ideasOnly) expect(visible).not.toContain(ownTask);
      else expect(visible).toContain(ownTask);
      expect(visible).not.toContain(foreignTask);
      expect(visible).not.toContain(trashedTask);
      const payload = JSON.stringify(response.json);
      expect(payload).not.toContain(foreignTask);
      expect(payload).not.toContain(trashedTask);
      expect(payload).not.toContain(`${query} foreign`);
      expect(payload).not.toContain(`${query} trash`);
    }
  }

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

test('SHO-REG-SEARCH-01 partial: record types and archive filters agree for Admin and Member', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This search audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-record-types';
  const query = zz(`search record types ${fixture.slice(0, 8)}`);
  let projectId = '';
  let orgId = '';
  later(async () => {
    if (!projectId || !orgId) return;
    const [project, organisation, person] = await Promise.all([
      admin.api.get(`/api/projects/${projectId}`),
      admin.api.get(`/api/orgs/${orgId}`),
      admin.api.get(`/api/team/${identity.id}`),
    ]);
    expect(project.status).toBe(200);
    expect(project.json.project.archived).toBe(true);
    expect(organisation.status).toBe(200);
    expect(organisation.json.organisation.archived).toBe(true);
    expect(person.status).toBe(200);
    expect(person.json.person.status).toBe('DEACTIVATED');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projectId, orgId, memberId: identity.id, projectArchived: true, organisationArchived: true, memberDeactivated: true }, null, 2));
  });
  const identity = await account(zz('Search record member'), `nakul17+zz-search-records-${fixture}@aplyd.com`);
  later(async () => {
    expect((await admin.api.post(`/api/team/${identity.id}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
    expect((await identity.c.post('/api/auth/signout')).status).toBe(204);
  });
  const member = await signInAs(browser, identity.email, PW);
  later(() => member.ctx.close());

  const project = await newProject(admin, later, { label: `${query} project`, members: [{ who: member, role: 'VIEWER' }] });
  projectId = project.id;
  const taskId = await newTask(admin, project.id, { title: `${query} task` });
  const organisation = await admin.api.post('/api/orgs', { name: `${query} organisation` });
  expect(organisation.status, JSON.stringify(organisation.json)).toBe(201);
  orgId = organisation.json.organisation.id as string;
  later(async () => {
    const stored = await admin.api.get(`/api/orgs/${orgId}`);
    if (stored.status === 200 && !stored.json.organisation.archived) {
      expect((await admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true })).status).toBe(200);
    }
  });
  const contact = await admin.api.post(`/api/orgs/${orgId}/contacts`, { name: `${query} contact` });
  expect(contact.status, JSON.stringify(contact.json)).toBe(201);
  const contactId = contact.json.contact.id as string;

  const search = async (who: typeof admin, archived = false, ideasOnly = false) => {
    const flags = `${archived ? '&archived=true' : ''}${ideasOnly ? '&idea=true' : ''}`;
    const response = await who.api.get(`/api/search?q=${encodeURIComponent(query)}${flags}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return response.json as { projects: { id: string }[]; tasks: { id: string }[]; organisations: { id: string }[]; contacts: { id: string }[] };
  };
  for (const who of [admin, member]) {
    const active = await search(who);
    expect(active.projects.map(row => row.id)).toContain(project.id);
    expect(active.tasks.map(row => row.id)).toContain(taskId);
    expect(active.organisations.map(row => row.id)).toContain(orgId);
    expect(active.contacts.map(row => row.id)).toContain(contactId);
    const ideas = await search(who, false, true);
    expect(ideas.tasks).toEqual([]);
    expect(ideas.organisations).toEqual([]);
    expect(ideas.contacts).toEqual([]);
  }

  await member.page.goto('/search');
  await member.page.getByRole('searchbox', { name: 'Search' }).fill(query);
  await expect(member.page.locator(`a.item[href="/projects/${project.id}"]`)).toBeVisible();
  await expect(member.page.locator(`a.item[href="/projects/${project.id}?task=${taskId}"]`)).toBeVisible();
  await expect(member.page.locator(`a.item[href="/accounts/${orgId}"]`).first()).toBeVisible();

  expect((await admin.api.post(`/api/projects/${project.id}/archive`)).status).toBe(200);
  expect((await admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true })).status).toBe(200);
  for (const who of [admin, member]) {
    const ordinary = await search(who);
    expect(ordinary.projects).toEqual([]);
    expect(ordinary.tasks).toEqual([]);
    expect(ordinary.organisations).toEqual([]);
    expect(ordinary.contacts).toEqual([]);
    const archived = await search(who, true);
    expect(archived.projects.map(row => row.id)).toContain(project.id);
    expect(archived.tasks.map(row => row.id)).toContain(taskId);
    expect(archived.organisations.map(row => row.id)).toContain(orgId);
    expect(archived.contacts.map(row => row.id)).toContain(contactId);
  }
  await member.page.getByRole('checkbox', { name: 'Include archived' }).check();
  await expect(member.page.locator(`a.item[href="/projects/${project.id}?task=${taskId}"]`)).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, taskId, orgId, contactId, adminMemberMatrix: true, archivedMatrix: true, ideasOnlyExcludesCrm: true, browserMatchesApi: true }, null, 2));
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
