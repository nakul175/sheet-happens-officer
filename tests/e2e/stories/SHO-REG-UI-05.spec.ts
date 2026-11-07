import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newProject, newTask, deleteFixtureTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-UI-05: task deep link survives refresh and history, then becomes unavailable after deletion', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('The navigation audit uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/ui-navigation-history';
  const sentinel = await newProject(admin, later, { label: 'navigation sentinel' });
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const project = await newProject(admin, later, { label: 'navigation journey' });
  const title = zz('navigation deep link');
  const taskId = await newTask(admin, project.id, { title });
  let outsiderId = '';
  later(async () => {
    await deleteFixtureTask(admin, taskId);
    const person = await admin.api.get(`/api/team/${outsiderId}`);
    expect(person.status).toBe(200);
    expect(person.json.person.status).toBe('DEACTIVATED');
    const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
    expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, ownedProjects: [sentinel.id, project.id], ownedPerson: outsiderId, personDeactivated: true, taskInTrash: true, sentinelPreserved: true, cleanup: true }, null, 2));
  });
  const outsider = await account(zz('navigation outsider'), `nakul17+zz-ui05-${fixture}@aplyd.com`);
  outsiderId = outsider.id;
  later(async () => {
    expect((await admin.api.post(`/api/team/${outsider.id}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
    expect((await outsider.c.post('/api/auth/signout')).status).toBe(204);
  });
  const hiddenReader = await signInAs(browser, outsider.email, PW);
  later(() => hiddenReader.ctx.close());
  const missingId = taskId.slice(0, -1) + (taskId.endsWith('a') ? 'b' : 'a');
  const readUnavailable = async (id: string) => {
    const response = await hiddenReader.page.request.get(`/tasks/${id}`, { maxRedirects: 0 });
    return { status: response.status(), html: await response.text() };
  };
  const hidden = await readUnavailable(taskId);
  const missing = await readUnavailable(missingId);
  expect(hidden.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(hidden.html).toBe(missing.html);
  expect(hidden.html).not.toContain(title);
  expect(hidden.html).toContain('/task-unavailable.css');
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
    cssResponses.length = 0;
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
    const latoLoaded = await tab.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('16px Lato');
    });
    expect(unavailableStyle.loadedStylesheets).toBeGreaterThan(0);
    expect(unavailableStyle.bodyMargin).toBe('0px');
    expect(unavailableStyle.bodyFont).toContain('Lato');
    expect(latoLoaded).toBe(true);
    await expect(tab.getByRole('link', { name: 'Go to My tasks' })).toHaveAttribute('href', '/my-tasks');
    mkdirSync(evidenceDir, { recursive: true });
    await tab.screenshot({ path: `${evidenceDir}/deleted-task-unavailable.png`, fullPage: true });
    writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, taskId, projectId: project.id, newTab: true, refresh: true, back: true, forward: true, hiddenAndMissingSame404: true, hiddenTitleAbsent: true, deletedDocumentStatus: 404, titleHiddenAfterDelete: true, unavailableStyle, latoLoaded, cssResponses, sentinelFingerprint, sentinelPreserved: true, privateRuntime: true }, null, 2));
    await tab.getByRole('link', { name: 'Go to My tasks' }).click();
    await expect(tab.getByRole('heading', { name: /my tasks/i }).first()).toBeVisible();
  } finally {
    await tab.close();
  }
});
