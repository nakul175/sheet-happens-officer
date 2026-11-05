import { test, expect, zz, archiveProject } from './qa';
import { newProject } from '../helpers/migration-2731';

test('SHO-REG-PROJECTS-01 API: create, edit, reload, activity and validation', async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: 'project create edit reload' });
  const name = zz('Renamed project');
  const changed = await admin.api.patch(`/api/projects/${p.id}`, { name, description: 'A persisted project description' });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);

  const detail = await admin.api.get(`/api/projects/${p.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.project).toMatchObject({ id: p.id, name, description: 'A persisted project description' });
  expect(detail.json.project.members.filter((m: { role: string }) => m.role === 'LEADER')).toHaveLength(1);
  expect(detail.json.project.sections.map((s: { name: string }) => s.name)).toEqual(['To do', 'In progress', 'Done']);
  const listed = await admin.api.get('/api/projects');
  expect(listed.json.projects.filter((row: { id: string }) => row.id === p.id)).toHaveLength(1);
  const activity = await admin.api.get(`/api/projects/${p.id}/activity`);
  expect(activity.status).toBe(200);
  expect(activity.json.items.some((row: { kind: string }) => row.kind === 'project.created')).toBe(true);
  expect(activity.json.items.some((row: { kind: string }) => row.kind === 'project.updated')).toBe(true);

  for (const body of [{ name: '   ' }, { name: 'x'.repeat(201) }, { description: 'x'.repeat(5001) }]) {
    expect((await admin.api.patch(`/api/projects/${p.id}`, body)).status).toBe(400);
  }
  expect((await member.api.patch(`/api/projects/${p.id}`, { name: 'Unauthorized' })).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${p.id}`)).json.project).toMatchObject({ name, description: 'A persisted project description' });
});

test('SHO-REG-PROJECTS-01 screen: create, edit, reload and inspect details', async ({ admin, later }) => {
  const page = admin.page;
  const originalName = zz('Screen project');
  const updatedName = zz('Screen project renamed');
  await page.goto('/projects/new');
  await page.getByLabel('Project name *').fill(originalName);
  await page.getByLabel('Description (optional)').fill('Initial description');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/?]+\?new=1/);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  later(() => archiveProject(admin.api, id, admin.user.id));

  await page.goto(`/projects/${id}/members`);
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.getByLabel('Project name').fill(updatedName);
  await page.getByLabel('Description').fill('Updated description');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.reload();
  await expect(page.getByText(updatedName, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Updated description', { exact: true })).toBeVisible();
  expect((await admin.api.get(`/api/projects/${id}`)).json.project).toMatchObject({ name: updatedName, description: 'Updated description' });
  await page.goto(`/projects/${id}/activity`);
  await expect(page.getByText(/renamed|changed|updated/i).first()).toBeVisible();
});
