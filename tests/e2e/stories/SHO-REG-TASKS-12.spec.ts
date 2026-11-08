import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, zz } from './qa';

test('SHO-REG-TASKS-12 cancelling a ready conversion leaves the task and unrelated project unchanged', async ({ admin, later }) => {
  if (!local2691) throw new Error('The conversion browser audit uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/conversion-cancel';
  const sentinel = await newProject(admin, later, { label: 'conversion sentinel' });
  const source = await newProject(admin, later, { label: 'conversion cancel source' });
  const taskId = await newTask(admin, source.id, { title: zz('conversion cancel task') });
  const org = await admin.api.post('/api/orgs', { name: zz('conversion cancel buyer') });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const organisationId = org.json.organisation.id as string;
  later(async () => {
    const current = await admin.api.get(`/api/orgs/${organisationId}`);
    if (current.status === 200 && !current.json.organisation.archived)
      expect((await admin.api.post(`/api/orgs/${organisationId}/archive`, { archive: true })).status).toBe(200);
    const organisation = await admin.api.get(`/api/orgs/${organisationId}`);
    expect(organisation.status).toBe(200);
    expect(organisation.json.organisation.archived).toBe(true);
    const task = await admin.api.get(`/api/tasks/${taskId}`);
    expect(task.status).toBe(200);
    expect(task.json.task.project.id).toBe(source.id);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, sourceProjectId: source.id, sentinelId: sentinel.id, organisationId, organisationArchived: true, taskUnconverted: true, cleanup: true }, null, 2));
  });
  const before = (await admin.api.get(`/api/tasks/${taskId}`)).json.task;
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  let conversionRequests = 0;
  const page = admin.page;
  await page.route(`**/api/tasks/${taskId}/convert`, async route => {
    conversionRequests++;
    await route.continue();
  });
  await page.goto(`/projects/${source.id}?task=${taskId}`);
  await page.getByRole('button', { name: 'Convert to deal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert to deal' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Organisation (buyer)').selectOption(organisationId);
  await dialog.getByLabel('Why are we pursuing this?').fill('This is a cancellation check');
  await expect(dialog.getByRole('button', { name: 'Convert to deal' })).toBeEnabled();
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/ready-dialog.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(conversionRequests).toBe(0);
  const after = (await admin.api.get(`/api/tasks/${taskId}`)).json.task;
  expect(after).toEqual(before);
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, organisationId, readyDialog: true, cancelled: true, conversionRequests, taskUnchanged: true, sentinelPreserved: true }, null, 2));
});
