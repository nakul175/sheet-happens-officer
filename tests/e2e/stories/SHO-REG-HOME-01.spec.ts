import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { BASE, PW, task, withVersion, zzTestData } from '../local-api';
import { expect } from './qa';

const day = (offset: number) => new Date(Date.now() + 5.5 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

test('SHO-REG-HOME-01 partial: Home cards and My tasks reconcile for owned work', async ({ browser, later }) => {
  if (!local2691) throw new Error('This Home audit case uses only the guarded local test database.');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
      !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname) || process.env.TASKBOARD_URL !== BASE)
    throw new Error('Use one loopback app and synthetic sho_test database for Home audit fixtures.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/home-reconciliation';
  const data = zzTestData(`home-${fixture}`);
  const ownedTasks: string[] = [];
  let ownedProject = '';
  let actorId = '';
  const actor = await data.person('Home Leader'); actorId = actor.id;
  later(async () => {
    for (const id of ownedTasks) {
      const removed = await actor.c.del(`/api/tasks/${id}`);
      expect([204, 404], JSON.stringify(removed.json)).toContain(removed.status);
      expect((await actor.c.get(`/api/tasks/${id}`)).status).toBe(404);
    }
    const problems = await data.cleanUp();
    expect(problems).toEqual([]);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, actorId, ownedProject, ownedTasks, cleanup: true }, null, 2));
  });

  const project = await data.project(actor); ownedProject = project.id;
  const created = async (label: string, dueDate: string) => {
    const id = await task(actor, project.id, { title: `ZZ-TEST ${label} ${fixture}`, assigneeId: actor.id, dueDate });
    ownedTasks.push(id);
    return id;
  };
  const overdue = await created('overdue', day(-1));
  const today = await created('today', day(0));
  const laterTask = await created('later', day(3));
  const completed = await created('completed', day(0));
  const closed = await actor.c.post(`/api/tasks/${completed}/complete`, await withVersion(actor, completed));
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);

  const cards = await actor.c.get('/api/dashboard?panel=tasks');
  expect(cards.status).toBe(200);
  expect(cards.json).toMatchObject({ open: 3, overdue: 1, awaiting: 0 });
  expect(cards.json.priorities.map((row: { id: string }) => row.id)).toEqual([overdue, today, laterTask]);
  const projects = await actor.c.get('/api/dashboard?panel=projects');
  expect(projects.status).toBe(200);
  expect(projects.json).toMatchObject({ total: 1, items: [{ id: project.id, total: 4, completed: 1, percent: 25 }] });
  const my = await actor.c.get('/api/my-tasks');
  expect(my.status).toBe(200);
  const myIds = [...my.json.waitingOnMe, ...my.json.overdue, ...my.json.next7, ...my.json.later].map((row: { id: string }) => row.id);
  expect(myIds.sort()).toEqual([overdue, today, laterTask].sort());
  expect(myIds).not.toContain(completed);

  const context = await browser.newContext({ baseURL: BASE });
  try {
    const signin = await context.request.post('/api/auth/signin', { data: { email: actor.email, password: PW } });
    expect(signin.status()).toBe(200);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
    const summary = page.getByLabel('Your work summary');
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    await expect(summary.getByRole('link', { name: /Overdue/ }).locator('strong')).toHaveText('1');
    await expect(summary.getByRole('link', { name: /Awaiting your approval/ }).locator('strong')).toHaveText('0');
    await expect(summary.getByRole('link', { name: /Active projects/ }).locator('strong')).toHaveText('1');
    const priorities = page.getByRole('region', { name: 'Your priorities' });
    for (const id of [overdue, today, laterTask]) await expect(priorities.locator(`a[href="/tasks/${id}"]`)).toBeVisible();
    await expect(priorities.locator(`a[href="/tasks/${completed}"]`)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your projects' }).getByText('1 of 4 tasks done')).toBeVisible();
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}/home-owned.png`, fullPage: true });
    await summary.getByRole('link', { name: /Open tasks/ }).click();
    await expect(page).toHaveURL(/\/my-tasks$/);
    const myTasksView = page.locator('.my-tasks-view');
    await expect(myTasksView.getByRole('heading', { name: 'My tasks' })).toBeVisible();
    for (const label of ['overdue', 'today', 'later'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toBeVisible();
    await expect(myTasksView.getByText(`ZZ-TEST completed ${fixture}`, { exact: true })).toHaveCount(0);
    // HOME-02: the Home overdue link is a URL filter; grouping is a per-user saved choice.
    await page.getByRole('button', { name: 'By project' }).click();
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
    await summary.getByRole('link', { name: /Overdue/ }).click();
    await expect(page).toHaveURL(/\/my-tasks\?filter=overdue$/);
    await expect(myTasksView.getByText(`ZZ-TEST overdue ${fixture}`, { exact: true })).toBeVisible();
    for (const label of ['today', 'later', 'completed'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('link', { name: 'Show all My tasks' }).click();
    await expect(page).toHaveURL(/\/my-tasks$/);
    for (const label of ['overdue', 'today', 'later'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toBeVisible();
    await page.goto(`/tasks/${today}`);
    await expect(page).toHaveURL(new RegExp(`/tasks/${today}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/my-tasks$/);
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/\/my-tasks\?filter=overdue$/);
    await expect(myTasksView.getByText(`ZZ-TEST overdue ${fixture}`, { exact: true })).toBeVisible();
    await expect(myTasksView.getByText(`ZZ-TEST today ${fixture}`, { exact: true })).toHaveCount(0);
    writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, actorId, ownedProject, ownedTasks, open: 3, overdue: 1, awaiting: 0, projects: 1, topLevel: 4, completed: 1, myTaskIds: myIds, homeAndMyTasksAgree: true }, null, 2));
  } finally { await context.close(); }
});
