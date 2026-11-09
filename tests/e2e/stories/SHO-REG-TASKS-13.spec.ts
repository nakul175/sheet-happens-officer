import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { newProject, newTask } from '../helpers/migration-2731';
import { patchCurrent } from '../helpers/jim-http';
import { activityRow } from '../helpers/screen-row';
import { expect, zz } from './qa';

test('SHO-REG-TASKS-13 Undo anyway restores only the older title and keeps a later priority edit', async ({ admin, later }) => {
  if (!local2691) throw new Error('Undo override browser audit requires the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/undo-override-browser';
  const sentinel = await newProject(admin, later, { label: 'Undo override sentinel' });
  const project = await newProject(admin, later, { label: 'Undo override source' });
  const original = zz('Undo original');
  const second = zz('Undo second');
  const third = zz('Undo third');
  const taskId = await newTask(admin, project.id, { title: original });
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelHash = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  later(async () => {
    const task = await admin.api.get(`/api/tasks/${taskId}`);
    expect(task.status).toBe(200);
    expect(task.json.task.title).toBe(original);
    expect(task.json.task.priority).toBe('HIGH');
    const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
    expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelHash);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, taskId, sourceProjectId: project.id, sentinelId: sentinel.id, taskRestored: true, laterPriorityPreserved: true, sentinelPreserved: true, cleanup: true }, null, 2));
  });

  expect((await patchCurrent(admin, taskId, { title: second })).status).toBe(200);
  expect((await patchCurrent(admin, taskId, { title: third, priority: 'HIGH' })).status).toBe(200);
  const items = (await admin.api.get(`/api/projects/${project.id}/activity`)).json.items as { id: string; what: string; undo: string }[];
  const first = items.find(item => item.what.includes(original) && item.what.includes(second));
  expect(first?.undo).toBe('available');

  const page = admin.page;
  await page.goto(`/projects/${project.id}/activity`);
  const row = activityRow(page, original, second);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Undo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo conflict' });
  await expect(dialog.getByRole('heading', { name: 'This changed after your action' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Undo anyway' })).toBeVisible();
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/conflict.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Undo anyway' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.title).toBe(original);
  const after = (await admin.api.get(`/api/tasks/${taskId}`)).json.task;
  expect(after.priority).toBe('HIGH');
  expect((await admin.api.post(`/api/actions/${first!.id}/undo`, { anyway: true })).status).toBe(409);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, original, second, third, undoActionId: first!.id, conflictVisible: true, explicitOverride: true, storedTitleRestored: true, laterPriorityPreserved: true, replayRejected: true }, null, 2));
});
