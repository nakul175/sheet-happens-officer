import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { local2691, test } from '../helpers/2691-admin';
import { raw } from '../helpers/jim-http';
import { account, PW } from '../local-api';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-CRM-01 scoped: organisation create, edit, role denial, duplicate, archive Undo and unrelated control', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This organisation audit fixture requires the guarded local test database.');
  test.setTimeout(180_000);
  const fixture = randomUUID();
  const evidenceDir = 'test-results/organisation-crud';
  const owned: string[] = [];
  later(async () => {
    for (const id of owned) {
      const loaded = await admin.api.get(`/api/orgs/${id}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.organisation.archived).toBe(true);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, owned, archived: true }, null, 2));
  });
  async function archiveAtCleanup(id: string) {
    later(async () => {
      const loaded = await admin.api.get(`/api/orgs/${id}`);
      expect(loaded.status).toBe(200);
      if (!loaded.json.organisation.archived)
        expect((await admin.api.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
    });
  }

  const sentinelName = zz('organisation sentinel');
  const sentinelMade = await admin.api.post('/api/orgs', { name: sentinelName });
  expect(sentinelMade.status).toBe(201);
  const sentinelId = sentinelMade.json.organisation.id as string;
  owned.push(sentinelId);
  await archiveAtCleanup(sentinelId);
  const sentinelBefore = (await admin.api.get(`/api/orgs/${sentinelId}`)).json.organisation;
  const fingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');

  const name = zz('organisation CRUD');
  await admin.page.goto('/accounts');
  await admin.page.getByRole('button', { name: '+ New organisation' }).click();
  const create = admin.page.getByRole('dialog', { name: 'New organisation' });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await create.getByRole('textbox', { name: 'Country' }).fill('India');
  await create.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(admin.page.getByRole('region', { name: 'Accounts' }).getByRole('link', { name })).toBeVisible();
  const matching = await admin.api.get(`/api/orgs?q=${encodeURIComponent(name)}`);
  expect(matching.status).toBe(200);
  const created = matching.json.organisations.filter((org: { name: string }) => org.name === name);
  expect(created).toHaveLength(1);
  const id = created[0].id as string;
  owned.push(id);
  await archiveAtCleanup(id);

  const member = await account(zz('organisation member'), `nakul17+zz-crm-01-${fixture}@aplyd.com`);
  later(async () => {
    expect((await admin.api.post(`/api/team/${member.id}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
  });
  const beforeDenied = await admin.api.get(`/api/orgs/${id}`);
  expect(beforeDenied.status).toBe(200);
  const roleFingerprint = createHash('sha256').update(JSON.stringify(beforeDenied.json.organisation)).digest('hex');
  expect((await member.c.get(`/api/orgs/${id}`)).status).toBe(200);
  expect((await member.c.patch(`/api/orgs/${id}`, { country: 'Unauthorised' })).status).toBe(403);
  expect((await member.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(403);
  const memberSession = await signInAs(browser, member.email, PW);
  try {
    await memberSession.page.goto(`/accounts/${id}`);
    await expect(memberSession.page.getByRole('heading', { name })).toBeVisible();
    await expect(memberSession.page.getByRole('button', { name: 'Edit organisation' })).toHaveCount(0);
  } finally { await memberSession.ctx.close(); }
  const afterDenied = await admin.api.get(`/api/orgs/${id}`);
  expect(createHash('sha256').update(JSON.stringify(afterDenied.json.organisation)).digest('hex')).toBe(roleFingerprint);

  await admin.page.goto(`/accounts/${id}`);
  await admin.page.getByRole('button', { name: 'Edit organisation' }).click();
  const edit = admin.page.getByRole('dialog', { name: 'Edit organisation' });
  const renamed = `${name} revised`;
  await edit.getByRole('textbox', { name: 'Organisation / client name' }).fill(renamed);
  await edit.getByRole('textbox', { name: 'Country' }).fill('Kenya');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toHaveCount(0);
  await expect(admin.page.getByRole('heading', { name: renamed })).toBeVisible();
  await expect(admin.page.getByText('Kenya', { exact: true })).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  await admin.page.screenshot({ path: `${evidenceDir}/edited.png`, fullPage: true });

  const duplicate = await admin.api.post('/api/orgs', { name: renamed.toUpperCase() });
  expect(duplicate.status).toBe(409);
  expect(duplicate.json.needsConfirm).toBe('duplicate');
  const missing = randomUUID();
  expect((await admin.api.get(`/api/orgs/${missing}`)).status).toBe(404);
  expect((await admin.api.patch(`/api/orgs/${missing}`, { country: 'Changed' })).status).toBe(404);
  expect((await admin.api.post(`/api/orgs/${missing}/archive`, { archive: true })).status).toBe(404);

  const changed = await raw(admin, 'PATCH', `/api/orgs/${id}`, { country: 'Nepal' });
  expect(changed.status).toBe(200);
  const editUndo = changed.headers['x-undo-id'];
  expect(editUndo).toBeTruthy();
  expect((await admin.api.post(`/api/actions/${editUndo}/undo`, { anyway: false })).status).toBe(200);
  expect((await admin.api.get(`/api/orgs/${id}`)).json.organisation.country).toBe('Kenya');

  const archived = await raw(admin, 'POST', `/api/orgs/${id}/archive`, { archive: true });
  expect(archived.status).toBe(200);
  const archiveUndo = archived.headers['x-undo-id'];
  expect(archiveUndo).toBeTruthy();
  await admin.page.reload();
  await expect(admin.page.getByText('This organisation is archived.')).toBeVisible();
  await admin.page.screenshot({ path: `${evidenceDir}/archived.png`, fullPage: true });
  expect((await admin.api.post(`/api/actions/${archiveUndo}/undo`, { anyway: false })).status).toBe(200);
  expect((await admin.api.get(`/api/orgs/${id}`)).json.organisation.archived).toBe(false);
  expect((await admin.api.get(`/api/orgs?q=${encodeURIComponent(renamed)}`)).json.organisations.filter((org: { name: string }) => org.name === renamed)).toHaveLength(1);

  const sentinelAfter = (await admin.api.get(`/api/orgs/${sentinelId}`)).json.organisation;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(fingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, id, sentinelId, created: true, edited: true, memberRead: true, memberWritesDenied: true, memberEditControlHidden: true, roleFingerprintPreserved: true, duplicateRefused: true, invalidIdsHidden: true, editUndo: true, archiveUndo: true, sentinelFingerprint: fingerprint, sentinelPreserved: true }, null, 2));
});
