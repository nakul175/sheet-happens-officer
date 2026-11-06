import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { expect, zz } from './qa';

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
