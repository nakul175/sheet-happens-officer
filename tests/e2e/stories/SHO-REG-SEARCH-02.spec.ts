import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-SEARCH-02 partial: direct long query bound and Unicode punctuation', async ({ admin, later }) => {
  if (!local2691) throw new Error('This search input audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-input-bound';
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
  async function organisation(name: string) {
    const result = await admin.api.post('/api/orgs', { name });
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
  const prefix = zz('bounded search ');
  const boundedName = prefix + 'x'.repeat(200 - prefix.length);
  expect(boundedName).toHaveLength(200);
  const boundedId = await organisation(boundedName);
  const unicodeName = zz('नमस्ते O’Hara');
  const unicodeId = await organisation(unicodeName);
  const get = async (q: string) => {
    const response = await admin.api.get(`/api/search?q=${encodeURIComponent(q)}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return response.json as { organisations: { id: string }[]; contacts: unknown[]; projects: unknown[]; tasks: unknown[] };
  };
  const oversized = await get(boundedName + 'y'.repeat(200));
  expect(oversized.organisations.map(row => row.id)).toContain(boundedId);
  expect((await get('नमस्ते O’Hara')).organisations.map(row => row.id)).toContain(unicodeId);
  expect((await get("'; DROP TABLE Organisation; --")).organisations).toEqual([]);
  expect(await get('x')).toEqual({ organisations: [], contacts: [], projects: [], tasks: [] });
  expect((await admin.api.get(`/api/orgs/${boundedId}`)).status).toBe(200);

  const page = admin.page;
  await page.goto('/search');
  const input = page.getByRole('searchbox', { name: 'Search' });
  expect(await input.getAttribute('maxlength')).toBe('200');
  await input.fill('नमस्ते O’Hara');
  await expect(page.locator(`a.item[href="/accounts/${unicodeId}"]`)).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/unicode-punctuation.png`, fullPage: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, boundedId, unicodeId, longQueryLength: 400, appliedLimit: 200, oneCharacterEmpty: true, sqlLikeInputSafe: true, unicodePunctuationFound: true, uiMaxLength: 200 }, null, 2));
});

test('SHO-REG-SEARCH-02: Unicode task query respects Member and outsider boundaries', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This Unicode permission audit uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/search-input-unicode-roles';
  const people: string[] = [];
  const projects: string[] = [];
  later(async () => {
    for (const id of projects) {
      const response = await admin.api.get(`/api/projects/${id}`);
      expect(response.status).toBe(200);
      expect(response.json.project.archived).toBe(true);
    }
    for (const id of people) {
      const response = await admin.api.get(`/api/team/${id}`);
      expect(response.status).toBe(200);
      expect(response.json.person.status).toBe('DEACTIVATED');
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, people, projects, cleanup: true }, null, 2));
  });
  async function person(role: string) {
    const identity = await account(zz(`Unicode ${role}`), `nakul17+zz-search-unicode-${fixture}-${role}@aplyd.com`);
    people.push(identity.id);
    later(async () => {
      expect((await admin.api.post(`/api/team/${identity.id}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
      expect((await identity.c.post('/api/auth/signout')).status).toBe(204);
    });
    const session = await signInAs(browser, identity.email, PW);
    later(() => session.ctx.close());
    return session;
  }
  const member = await person('member');
  const outsider = await person('outsider');
  const own = await newProject(admin, later, { label: 'Unicode member', members: [{ who: member, role: 'VIEWER' }] });
  const foreign = await newProject(admin, later, { label: 'Unicode foreign' });
  projects.push(own.id, foreign.id);
  const query = zz(`नमस्ते 漢字 ${fixture.slice(0, 8)}`);
  const ownTask = await newTask(admin, own.id, { title: `${query} own` });
  const foreignTask = await newTask(admin, foreign.id, { title: `${query} foreign` });
  const search = async (session: typeof member) => {
    const response = await session.api.get(`/api/search?q=${encodeURIComponent(query)}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return response.json as { tasks: { id: string }[] };
  };
  expect((await search(member)).tasks.map(row => row.id)).toContain(ownTask);
  expect((await search(member)).tasks.map(row => row.id)).not.toContain(foreignTask);
  expect((await search(outsider)).tasks.map(row => row.id)).toEqual([]);
  await member.page.goto('/search');
  await member.page.getByRole('searchbox', { name: 'Search' }).fill(query);
  await expect(member.page.locator(`a.item[href="/projects/${own.id}?task=${ownTask}"]`)).toBeVisible();
  await expect(member.page.locator(`a.item[href="/projects/${foreign.id}?task=${foreignTask}"]`)).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, query, ownTask, foreignTask, memberOwnVisible: true, memberForeignHidden: true, outsiderEmpty: true, browserOwnVisible: true, browserForeignHidden: true }, null, 2));
});
