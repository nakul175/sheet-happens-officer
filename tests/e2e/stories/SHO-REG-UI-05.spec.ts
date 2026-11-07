import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { newProject, newTask, deleteFixtureTask } from '../helpers/migration-2731';
import { expect, zz } from './qa';

test('SHO-REG-UI-05: task deep link survives refresh and history, then becomes unavailable after deletion', async ({ admin, later }) => {
  if (!local2691) throw new Error('The navigation audit uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/ui-navigation-history';
  const sentinel = await newProject(admin, later, { label: 'navigation sentinel' });
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const project = await newProject(admin, later, { label: 'navigation journey' });
  const title = zz('navigation deep link');
  const taskId = await newTask(admin, project.id, { title });
  later(async () => {
    await deleteFixtureTask(admin, taskId);
    const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
    expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedProjects: [sentinel.id, project.id], taskInTrash: true, sentinelPreserved: true, cleanup: true }, null, 2));
  });

  const tab = await admin.page.context().newPage();
  const cssResponses: { path: string; status: number }[] = [];
  tab.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('.css')) cssResponses.push({ path: url.pathname, status: response.status() });
  });
  try {
    await tab.goto(`/tasks/${taskId}`);
    await expect(tab.getByText(title, { exact: true }).first()).toBeVisible();
    await tab.reload();
    await expect(tab.getByText(title, { exact: true }).first()).toBeVisible();
    await tab.goto('/my-tasks');
    await expect(tab.getByRole('heading', { name: /my tasks/i }).first()).toBeVisible();
    await tab.goBack();
    await expect(tab.getByText(title, { exact: true }).first()).toBeVisible();
    await tab.goForward();
    await expect(tab.getByRole('heading', { name: /my tasks/i }).first()).toBeVisible();

    expect((await admin.api.del(`/api/tasks/${taskId}`)).status).toBe(204);
    const unavailable = await tab.goto(`/tasks/${taskId}`);
    expect(unavailable?.status()).toBe(404);
    await expect(tab.getByRole('heading', { name: "This task isn't available" })).toBeVisible();
    await expect(tab.getByText(title, { exact: true })).toHaveCount(0);
    const unavailableStyle = await tab.evaluate(() => ({
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
      bodyMargin: getComputedStyle(document.body).margin,
      bodyFont: getComputedStyle(document.body).fontFamily,
      stylesheetLinks: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new URL(link.href).pathname),
      loadedStylesheets: document.styleSheets.length,
    }));
    expect(unavailableStyle.loadedStylesheets).toBeGreaterThan(0);
    expect(unavailableStyle.bodyMargin).toBe('0px');
    expect(unavailableStyle.bodyFont).not.toBe('"Times New Roman"');
    mkdirSync(evidenceDir, { recursive: true });
    await tab.screenshot({ path: `${evidenceDir}/deleted-task-unavailable.png`, fullPage: true });
    writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, projectId: project.id, newTab: true, refresh: true, back: true, forward: true, deletedDocumentStatus: 404, titleHiddenAfterDelete: true, unavailableStyle, cssResponses, sentinelFingerprint, sentinelPreserved: true, privateRuntime: true }, null, 2));
  } finally {
    await tab.close();
  }
});
