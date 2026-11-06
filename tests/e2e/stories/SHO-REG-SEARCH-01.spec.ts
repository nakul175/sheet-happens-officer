import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { expect, zz } from './qa';

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
